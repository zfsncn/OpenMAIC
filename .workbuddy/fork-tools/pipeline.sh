#!/usr/bin/env bash
# ============================================================================
# 一键改造流水线：fork commit → 同步现场 → docker build → 部署 3002 → 验收
#
# 用法：
#   bash .workbuddy/fork-tools/pipeline.sh              # 全程 dry-run（不动任何东西）
#   bash .workbuddy/fork-tools/pipeline.sh --apply      # 真跑：sync + build + 重建容器
#   bash .workbuddy/fork-tools/pipeline.sh --apply --no-build   # 只同步+部署，沿用现役镜像
#   bash .workbuddy/fork-tools/pipeline.sh --apply --prune      # 同步时删除 fork 已删的源码
#   bash .workbuddy/fork-tools/pipeline.sh --apply --tag <名称>  # 自定义回滚标签后缀
#
# 本脚本可从任意目录调用。所有路径均为绝对路径。
#
# ⚠️⚠️ 安全边界（红线）
#   1. **绝不在 D:\OpenMAIC 或 D:\soft\OpenMAIC 跑 `docker compose up`** ——
#      compose 工程名从目录名派生，会接管用户在 3000 的既有栈。本脚本只用 docker build/run。
#   2. 部署只走 `.workbuddy/deploy/start-3002.sh --run`（env 是创建期写死的，restart 无效）。
#   3. **3003 / 3006 绝不自动同步** —— 需用户明确要求才可，作为独立一步。
#   4. build 前自动打回滚标签 `openmaic-new:pre-<tag>`，出问题可 `docker tag` 回退。
#   5. 只改代码不改数据；任何 DB 变更须单独授权并先 pg_dump。
# ============================================================================
set -euo pipefail

FORK='D:\OpenMAIC-fork'
LIVE='D:\OpenMAIC'
APP='openmaic-new'
APP_IMG='openmaic-new:latest'
PORT='3002'
HERE="$(cd "$(dirname "$0")" && pwd)"
PYEXE='C:/Users/zfsnc/.workbuddy/binaries/python/versions/3.13.12/python.exe'
START3002='D:\OpenMAIC\.workbuddy\deploy\start-3002.sh'

APPLY=0; DO_BUILD=1; PRUNE=0; TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)    APPLY=1 ;;
    --no-build) DO_BUILD=0 ;;
    --prune)    PRUNE=1 ;;
    --tag)      TAG="${2:-}"; shift ;;
    -h|--help)  sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "未知参数：$1（用 --help 看用法）" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$TAG" ] || TAG="pipeline-$(date +%Y%m%d-%H%M%S)"
SYNC_MODE=$([ "$PRUNE" -eq 1 ] && echo "--apply-prune" || echo "--apply")

hr(){ echo "══════════════════════════════════════════════════════════"; }

# ── 护栏：源码树根不能有 .env.local（会被打进镜像层/分发包） ─────────────
guard_no_env(){
  if [ -f "$LIVE/.env.local" ]; then
    echo "❌ 危险：$LIVE 根目录存在 .env.local ⇒拒绝继续（会泄漏密钥）。" >&2
    echo "   正确位置：$LIVE\\.workbuddy\\secrets\\.env.local" >&2
    exit 1
  fi
}

# ── 护栏：3000 用户栈不能被我们碰到 ─────────────────────────────────────
guard_port(){
  local on3000
  on3000=$(docker ps --format '{{.Names}}\t{{.Ports}}' | grep -E ':3000->' || true)
  if [ -n "$on3000" ]; then
    echo "ℹ️检测到 3000 端口有容器在跑（用户栈）：" >&2
    echo "$on3000" | sed 's/^/   /' >&2
    echo "   本流水线只操作 $APP(:$PORT)，不会碰它。" >&2
  fi
}

# ── 护栏：fork 必须已 commit（脏树会把半成品同步到现场） ────────────────
guard_fork_clean(){
  local dirty
  dirty=$(cd "$(cygpath -u "$FORK")" && git status --porcelain)
  if [ -n "$dirty" ]; then
    echo "❌ fork 工作树有未提交改动，拒绝同步（否则现场会拿到半成品）：" >&2
    echo "$dirty" | head -20 | sed 's/^/   /' >&2
    echo "   先在 fork 里 git add -A && git commit。" >&2
    exit 1
  fi
}

hr; echo " OpenMAIC 改造流水线"; hr
echo "fork = $FORK"
echo "现场 = $LIVE"
echo "模式 = $([ "$APPLY" -eq 1 ] && echo 'APPLY（真跑）' || echo 'DRY-RUN（不动任何东西）')"
echo "同步 = $SYNC_MODE | 构建 = $([ "$DO_BUILD" -eq 1 ] && echo '是' || echo '否') | 回滚标签 = pre-$TAG"
echo

guard_no_env
guard_port
guard_fork_clean

# ── [0] 记录回滚基线 ───────────────────────────────────────────────────
hr; echo ">>> [0/5] 记录回滚基线"
OLD_ID=$(docker inspect "$APP" --format '{{.Image}}' 2>/dev/null || echo '(容器不存在)')
echo "现役容器镜像 = $OLD_ID"
if [ "$APPLY" -eq 1 ]; then
  if [ -n "$OLD_ID" ] && [ "$OLD_ID" != "(容器不存在)" ]; then
    docker tag "$OLD_ID" "openmaic-new:pre-$TAG"
    echo "✅ 已打回滚标签 openmaic-new:pre-$TAG"
  fi
fi

# ── [1] 同步 fork → 现场 ───────────────────────────────────────────────
hr; echo ">>> [1/5] 同步 fork → 现场"
SYNC_SH="$HERE/sync-fork-to-live.sh"
if [ "$APPLY" -eq 1 ]; then
  bash "$SYNC_SH" "$SYNC_MODE" || { echo "❌ 同步失败，已中止（未 build、未动容器）。" >&2; exit 1; }
else
  bash "$SYNC_SH" dry-run
  echo ""
  echo ">>> DRY-RUN：以上为将要发生的同步。加 --apply 真正执行。"
  exit 0
fi

# ── [2] 门控（快速 sanity，避免把编译错误打进镜像） ────────────────────
hr; echo ">>> [2/5] 门控：TypeScript 类型检查"
if [ "$DO_BUILD" -eq 1 ]; then
  if [ ! -d "$(cygpath -u "$LIVE")/node_modules" ]; then
    echo "⚠️ 现场无 node_modules，跳过 tsc（首次请先 corepack enable && pnpm install）"
  else
    ( cd "$(cygpath -u "$LIVE")" && corepack enable >/dev/null 2>&1 || true; \
      npx --no-install tsc --noEmit ) \
      && echo "✅ tsc 0 错误" \
      || { echo "❌ tsc 有错误 —— 已中止，未 build、未动容器。修完再跑。" >&2; exit 1; }
  fi
else
  echo "跳过（--no-build）"
fi

# ── [3] docker build ───────────────────────────────────────────────────
hr; echo ">>> [3/5] docker build"
if [ "$DO_BUILD" -eq 1 ]; then
  echo "构建上下文 = $LIVE（同步后的现场树）"
  echo "⚠️ 构建期间不要改任何源码（COPY . . 在早期执行，中途改的不进镜像）。"
  ( cd "$(cygpath -u "$LIVE")" && docker build -t "$APP_IMG" . ) \
    || { echo "❌ 构建失败，容器未动，现役服务不受影响。" >&2; exit 1; }
  NEW_ID=$(docker inspect "$APP_IMG" --format '{{.Id}}')
  echo "✅ 新镜像 = $NEW_ID"
  if [ "$NEW_ID" = "$OLD_ID" ]; then
    echo "ℹ️ 镜像 ID 与现役完全相同 ⇒ 本轮源码无实际变化。"
  fi
else
  echo "跳过（--no-build），沿用现役镜像 $OLD_ID"
fi

# ── [4] 重建 3002 容器 ────────────────────────────────────────────────
hr; echo ">>> [4/5] 重建 3002 容器（DB 容器不动，数据在命名卷中安全）"
echo "访问码 openmaic；3003/3006 本轮不触碰。"
bash "$(cygpath -u "$START3002")" --run || { echo "❌ 容器重建失败。" >&2; exit 1; }

# ── [5] 验收 ──────────────────────────────────────────────────────────
hr; echo ">>> [5/5] 3002 验收"
sleep 3
FAIL=0
echo "--- 5.1 健康检查 ---"
H=$(curl -s --noproxy '*' "http://127.0.0.1:$PORT/api/health" || true)
echo "$H"
case "$H" in *'"success":true'*) echo "✅ 健康" ;; *) echo "❌ 健康检查失败"; FAIL=1 ;; esac

echo "--- 5.2 首页 HTTP ---"
CODE=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "http://127.0.0.1:$PORT/" || echo 000)
echo "GET / => $CODE"
case "$CODE" in 200|307) echo "✅ 首页可达" ;; *) echo "❌ 首页异常"; FAIL=1 ;; esac

echo "--- 5.3 镜像一致性（容器用的必须就是刚构建的镜像）---"
CTR_IMG=$(docker inspect "$APP" --format '{{.Image}}')
TAGGED=$(docker inspect "$APP_IMG" --format '{{.Id}}')
echo "容器 = $CTR_IMG"
echo "标签 = $TAGGED"
if [ "$CTR_IMG" = "$TAGGED" ]; then echo "✅ 容器已运行新镜像"; else echo "❌ 容器与镜像不一致"; FAIL=1; fi

echo "--- 5.4 数据未丢（查库，红线 8）---"
STAGES=$(docker exec -i openmaic-new-db psql -U openmaic -d openmaic -tAc \
  "SELECT count(*) FROM document_stages WHERE deleted_at IS NULL;" 2>/dev/null | tr -d ' \r' || echo 'ERR')
SCENES=$(docker exec -i openmaic-new-db psql -U openmaic -d openmaic -tAc \
  "SELECT count(*) FROM document_scenes;" 2>/dev/null | tr -d ' \r' || echo 'ERR')
echo "在世课程 = ${STAGES:-ERR} | 场景 = ${SCENES:-ERR}"
if [ "$STAGES" = "ERR" ] || [ -z "$STAGES" ]; then echo "❌ 查库失败"; FAIL=1;
else echo "✅ 数据在位"; fi

hr
if [ "$FAIL" -eq 0 ]; then
  echo "✅ 流水线全部通过。3002 = http://127.0.0.1:$PORT"
  echo "   回滚：docker tag openmaic-new:pre-$TAG $APP_IMG && bash <start-3002.sh> --run"
else
  echo "❌ 验收有失败项，见上。"
fi
hr
exit "$FAIL"