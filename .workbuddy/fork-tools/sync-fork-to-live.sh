#!/usr/bin/env bash
# ============================================================================
# fork → 现场同步（D:\OpenMAIC-fork → D:\OpenMAIC）
#
# 用法：
#   bash sync-fork-to-live.sh                # dry-run：只展示差异
#   bash sync-fork-to-live.sh --apply        # 同步 + 漂移校验
#   bash sync-fork-to-live.sh --apply-prune  # 同步 + 删除「现场独有」文件 + 校验
#
# ⚠️ 本脚本可从任意目录调用（内部用绝对路径）。fork 与现场各存一份同名副本，
#    内容须保持一致；**Git 事实源 = D:\OpenMAIC-fork\.workbuddy\fork-tools\**。
#
# 排除项 = 运行态 / 依赖 / 秘密（两边各自独立，永不互相覆盖）
#   node_modules .next .workbuddy data dist test-results
#   playwright-report blob-report coverage .git .codegraph
#   tsconfig.tsbuildinfo .env.local _diag.txt  packages/*/rollup.config-*.cjs
# ============================================================================
set -euo pipefail

LIVE='D:\OpenMAIC'
FORK='D:\OpenMAIC-fork'
PYEXE='C:/Users/zfsnc/.workbuddy/binaries/python/versions/3.13.12/python.exe'

# robocopy 需要 Windows 原生路径；用 cygpath 转换，避免 Git Bash 路径歧义
w() { cygpath -w "$1"; }

snapshot() {  # $1 = root(cyg 风格), $2 = out.json
  "$PYEXE" - "$1" "$2" <<'PY'
import os, hashlib, sys, json, fnmatch
root, out = sys.argv[1], sys.argv[2]
SKIP = {'node_modules','.next','.git','.codegraph','data','test-results',
        'playwright-report','blob-report','coverage','.workbuddy','dist'}
XFILE = {'tsconfig.tsbuildinfo','.env.local','_diag.txt'}
XGLOT = ['packages/*/rollup.config-*.cjs',   # 构建期临时产物，非源码
         '历史副本*']                          # 0 字节杂项：见下方说明
# ⚠️ `历史副本（内容相同），保留仅作回退，**不要再改它**。` 是仓库根一个 0 字节
#    文件，不属于源码。它**会被某个外部进程反复重建**（2026-10-11 移走三次、每次
#    流水线前又出现），而现场不是 git 仓库、git 状态拦不住它，于是每轮同步的漂移
#    校验都会报「仅现场=1」并拒绝 build。既然它不是源码，就在快照层忽略它，避免
#    一个空文件反复阻断整条流水线。（文件本身未删除，备份在
#    `.workbuddy/tmp/legacy-empty-files/`。）
m = {}
for r, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in SKIP]
    for f in files:
        rel = os.path.relpath(os.path.join(r, f), root).replace(os.sep, '/')
        if rel in XFILE: continue
        if any(fnmatch.fnmatch(rel, g) for g in XGLOT): continue
        try:
            with open(os.path.join(r, f), 'rb') as fh:
                m[rel] = hashlib.md5(fh.read()).hexdigest()
        except OSError:
            pass
json.dump(m, open(out, 'w', encoding='utf-8'))
PY
}

report() {  # $1=label $2=fork.json $3=live.json
  "$PYEXE" - "$1" "$2" "$3" <<'PY'
import json, sys
label = sys.argv[1]
ja = json.load(open(sys.argv[2], encoding='utf-8'))
jb = json.load(open(sys.argv[3], encoding='utf-8'))
only_a = sorted(ja.keys() - jb.keys())
only_b = sorted(jb.keys() - ja.keys())
diff = sorted(k for k in ja.keys() & jb.keys() if ja[k] != jb[k])
print(f"[{label}] 仅fork={len(only_a)} 仅现场={len(only_b)} 内容不同={len(diff)} (fork={len(ja)} 现场={len(jb)})")
for x in only_a[:15]: print('   +仅fork', x)
for x in only_b[:15]: print('   -仅现场', x)
for x in diff[:15]:  print('   ~不同  ', x)
PY
}

MODE="${1:-dry-run}"
# ⚠️ Why not `mktemp -d`: on Git Bash it returns a MIXED path
# ("C:\Users\...\Temp/tmp.XXXX" — drive prefix + forward slashes), and this
# session's safe-delete guard rejects ANY drive-prefixed `rm -rf` with
# `SAFE_DELETE_INVALID_PATH: embedded drive prefix`. That made the cleanup trap
# fail and aborted the pipeline right AFTER a successful sync (observed
# 2026-10-11). A pure POSIX /tmp path has no drive prefix and deletes cleanly,
# so pin the temp dir there explicitly.
TMP="/tmp/openmaic-sync-$$-$(date +%s)"
mkdir -p "$TMP" || { echo "无法创建临时目录 $TMP" >&2; exit 1; }
trap 'rm -rf "$TMP"' EXIT

echo ">>> [1/4] 同步前差异"
snapshot "$FORK" "$TMP/fork-before.json"
snapshot "$LIVE" "$TMP/live-before.json"
report "before" "$TMP/fork-before.json" "$TMP/live-before.json"

if [ "$MODE" = "dry-run" ]; then
  echo ""
  echo ">>> dry-run 结束（未动任何文件）。执行其一："
  echo "    bash sync-fork-to-live.sh --apply         # 同步（现场独有的文件保留）"
  echo "    bash sync-fork-to-live.sh --apply-prune   # 同步并删除现场独有文件（用于 fork 删了源码时）"
  exit 0
fi

# ── robocopy 排除清单 ────────────────────────────────────────────────────
# ⚠️ node_modules 必须写**全路径**：本仓库是 pnpm workspace，嵌套依赖有 2500+ 个
#    （packages/*/node_modules、node_modules/.pnpm/*/node_modules……）。
#    只排除顶层的话，robocopy 会去遍历嵌套依赖；其中被进程占用的 .js 会触发
#    「另一个程序正在使用此文件」而**每个文件空等 30 秒**——单文件就能把整轮
#    同步拖成十几分钟（2026-10-11 实测 12 分钟仍未完，已手工终止）。
#    ⇒ 用目录名做排除（不写全路径），让 robocopy 在任何层级都跳过。
XDIR=(node_modules .next .workbuddy data dist test-results playwright-report
      blob-report coverage .git .codegraph .turbo)
XFILE=(tsconfig.tsbuildinfo .env.local _diag.txt rollup.config-*.cjs)

run_robocopy() {  # $1=src $2=dst $3=输出文件
  local a=("$1" "$2" //E //NFL //NDL //NJH //NP //R:1 //W:1)
  for d in "${XDIR[@]}"; do a+=(//XD "$d"); done
  for f in "${XFILE[@]}"; do a+=(//XF "$f"); done
  local rc=0
  # ⚠️ 修复：原写法 `robocopy ... || true; echo $?` 因 $? 被 true 覆盖而恒为 0，
  #    robocopy 失败（≥8）会被静默吞掉。正确做法是取到真实返回码再判断。
  robocopy "${a[@]}" > "$3" 2>&1 || rc=$?
  echo "$rc"
}

rc=$(run_robocopy "$(w "$FORK")" "$(w "$LIVE")" "$TMP/rc.txt")
if [ "$rc" -ge 8 ]; then
  echo "❌ robocopy 失败，exit=$rc（≥8 即失败）" >&2
  tail -30 "$TMP/rc.txt" >&2
  exit 1
fi
echo "robocopy exit=$rc（0-7 均成功；/R:1 /W:1 已关闭长等待）"

if [ "$MODE" = "apply-prune" ]; then
  echo ""
  echo ">>> [3/4] prune：删除「现场独有、fork 已无」的源码文件"
  "$PYEXE" - "$TMP/fork-before.json" "$TMP/live-before.json" "$LIVE" <<'PY'
import json, os, sys
ja = json.load(open(sys.argv[1], encoding='utf-8'))
jb = json.load(open(sys.argv[2], encoding='utf-8'))
live = sys.argv[3]
only_live = sorted(jb.keys() - ja.keys())
if not only_live:
    print("   无现场独有文件，跳过。")
for rel in only_live:
    p = os.path.join(live, rel.replace('/', os.sep))
    try:
        os.remove(p); print('   -删除', rel)
    except OSError as e:
        print(f'   ❌ 删除失败 {rel}: {e}', file=sys.stderr); raise SystemExit(1)
# 清理空目录（自底向上）
for r, dirs, files in os.walk(live, topdown=False):
    if os.path.abspath(r) == os.path.abspath(live): continue
    if '.workbuddy' in r or 'node_modules' in r or '.git' in r: continue
    try:
        if not os.listdir(r): os.rmdir(r)
    except OSError: pass
PY
else
  echo ""
  echo ">>> [3/4] prune：跳过（本次模式 $MODE，不删除任何文件）"
  echo "   注意：fork 里删除的源码不会自动从现场消失 ⇒ 收尾会报「仅现场>0」。"
  echo "   若确认为有意删除，改用 --apply-prune。"
fi

echo ""
echo ">>> [4/4] 同步后漂移校验"
snapshot "$FORK" "$TMP/fork-after.json"
snapshot "$LIVE" "$TMP/live-after.json"
report "after" "$TMP/fork-after.json" "$TMP/live-after.json"

"$PYEXE" - "$TMP/fork-after.json" "$TMP/live-after.json" <<'PY'
import json, sys
ja = json.load(open(sys.argv[1], encoding='utf-8'))
jb = json.load(open(sys.argv[2], encoding='utf-8'))
bad = len(ja.keys() - jb.keys()) + len(jb.keys() - ja.keys()) + \
      sum(1 for k in ja.keys() & jb.keys() if ja[k] != jb[k])
print()
if bad == 0:
    print("✅漂移校验通过：fork ≡ 现场（0/0/0）。现场可以 docker build 了。")
    sys.exit(0)
print(f"❌ 仍有 {bad} 处差异！现场 ≠ fork，**不要 build**。请把上面 after 清单发给 AI 排查。")
sys.exit(1)
PY