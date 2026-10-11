#!/usr/bin/env bash
# ============================================================================
# 3002-only 护栏 —— 防止误触3003 / 3006
#
# 用户指令（2026-10-11）：
#   「除非有我 2 次的确认，后续都不针对 3003 / 3006 做任何的触碰，
#     所有的改造、操作都仅在 3002 上进行」
#
# 用法：
#   bash guard-3002-only.sh--scan            # 扫描默认脚本目录（防回归）
#   bash guard-3002-only.sh --scan<目录>      # 扫描指定目录
#   bash guard-3002-only.sh --check           # 只做环境自检（远端是否在监听/可达）
#
# 退出码：0 = 通过；1 = 发现远端触碰风险（阻断）
#
# ⚠️ 本脚本**只检测 ssh/scp/rsync 等远程传输命令**是否指向禁止目标，
#    不会去连接远端。检测到即拒绝执行，并提示需要用户的两次明确确认。
# ============================================================================
set -o pipefail

# ── 禁止触碰的目标（3003 = Debian 内网机/ 3006 = 腾讯云）──────────────────
FORBIDDEN_HOSTS=(
  "192.168.31.66"     # 3003 Debian
  "49.235.171.87"     # 3006 腾讯云
)
FORBIDDEN_PORTS=(3003 3006)
# 远端 compose 工程目录别名（若将来出现）
FORBIDDEN_TOKENS=("debian" "tencent" "openmaic-3003" "openmaic-3006")

REMOTE_CMDS='(ssh|scp|rsync|sftp|docker[[:space:]]+save|pg_dumpall[[:space:]]*\|)'

hr(){ echo "══════════════════════════════════════════════════════════"; }
pass(){ echo "✅ $1"; }
fail(){ echo "❌ $1" >&2; }

hr
echo " 3002-only 护栏"
hr
echo "允许操作：D:\\OpenMAIC（3002 本机）"
echo "禁止触碰：3003（192.168.31.66） · 3006（49.235.171.87）"
echo "解禁条件：需用户 **两次** 明确确认（单次口头/单条消息不算）"
echo

# ── 1. 静态扫描：脚本里是否写了指向远端的传输命令 ─────────────────────
SCAN_DIR=""
case "${1:-}" in
  --scan) SCAN_DIR="${2:-$(cd "$(dirname "$0")" && pwd)}" ;;
  --check) SCAN_DIR="" ;;
  "")     SCAN_DIR="$(cd "$(dirname "$0")" && pwd)" ;;
  *)      SCAN_DIR="${2:-$(cd "$(dirname "$0")" && pwd)}" ;;
esac

if [ -n "$SCAN_DIR" ]; then
  [ -d "$SCAN_DIR" ] || { fail "扫描目录不存在：$SCAN_DIR"; exit 1; }
  echo ">>> [1/2] 静态扫描远程传输命令：$SCAN_DIR"
  HITS=0
  while IFS= read -r -d '' f; do
    for tok in "${FORBIDDEN_HOSTS[@]}"; do
      # 仅当远程传输命令附近出现禁止目标才判定为风险（避免误报普通注释）
      if grep -nEi "$REMOTE_CMDS[^|;&]*${tok//./\\.}" "$f" 2>/dev/null | grep -v '^\s*[0-9]*:\s*#' | grep -q .; then
        echo "   ⚠️  $(basename "$f"): 含指向 $tok 的远程传输命令"
        grep -nEi "$REMOTE_CMDS[^|;&]*${tok//./\\.}" "$f" | head -3 | sed 's/^/       /'
        HITS=$((HITS+1))
      fi
    done
  done < <(find "$SCAN_DIR" -maxdepth 2 -type f \( -name '*.sh' -o -name '*.py' \) -print0 2>/dev/null)

  if [ "$HITS" -eq 0 ]; then
    pass "未发现指向 3003/3006 的远程传输命令"
  else
    fail "发现 $HITS 处远端触碰风险 —— 已阻断"
    echo "   若确需操作远端，必须先获得用户两次明确确认。" >&2
    exit 1
  fi
else
  echo ">>> [1/2] 静态扫描：跳过（--check 模式）"
fi

# ── 2. 环境自检：仅陈述事实，不发起连接 ────────────────────────────────
echo
echo ">>> [2/2] 环境自检（只读，不连接远端）"
# 检查本地是否存在指向远端的挂载/网络（说明可能曾建立连接）
MOUNTS=$(docker inspect openmaic-new --format '{{range .Mounts}}{{.Source}}->{{.Destination}} {{end}}' 2>/dev/null || echo '')
if echo "$MOUNTS" | grep -qE '192\.168\.31\.66|49\.235\.171\.87'; then
  fail "容器挂载了远端路径：$MOUNTS"
  exit 1
fi
pass "本地容器无远端挂载"

LOCAL_OK=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/health 2>/dev/null || echo 000)
if [ "$LOCAL_OK" = "200" ]; then pass "3002 本机健康（这是唯一允许操作的端）"
else echo "ℹ️  3002 健康检查返回 $LOCAL_OK（不影响护栏判定）"; fi

hr
echo "✅ 护栏通过：本轮仅允许在 3002（D:\\OpenMAIC）操作。"
hr
exit 0