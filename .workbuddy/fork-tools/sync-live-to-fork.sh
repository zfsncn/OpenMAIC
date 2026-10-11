#!/usr/bin/env bash
# ============================================================================
# 现场 → fork 回灌（D:\OpenMAIC → D:\OpenMAIC-fork）
#
# 用法：
#   bash sync-live-to-fork.sh           # dry-run：展示现场比 fork 多/改了什么
#   bash sync-live-to-fork.sh --apply   # robocopy 回灌（**不自动 commit**）
#
# ⚠️ 仅在「你在现场直接改了代码」时使用。正常流程是改在 fork 再 sync-fork-to-live，
#    方向相反。本脚本用于把现场的临时改动收回 Git 管理。
# 回灌后 fork 里会出现未提交变更（git status 可见），由你/AI 审阅后分组 commit。
#
# ⚠️ Git 事实源 = D:\OpenMAIC-fork\.workbuddy\fork-tools\（本文件的副本）
# ============================================================================
set -euo pipefail

LIVE='D:\OpenMAIC'
FORK='D:\OpenMAIC-fork'
PYEXE='C:/Users/zfsnc/.workbuddy/binaries/python/versions/3.13.12/python.exe'

w() { cygpath -w "$1"; }

snapshot() {  # $1 = root, $2 = out.json（用文件传参：命令行传大JSON 会 Argument list too long）
  "$PYEXE" - "$1" "$2" <<'PY'
import os, hashlib, sys, json, fnmatch
root, out = sys.argv[1], sys.argv[2]
SKIP = {'node_modules','.next','.git','.codegraph','data','test-results',
        'playwright-report','blob-report','coverage','.workbuddy','dist'}
XFILE = {'tsconfig.tsbuildinfo','.env.local','_diag.txt'}
XGLOT = ['packages/*/rollup.config-*.cjs']
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

echo ">>> [1/3] 回灌前差异（现场 vs fork）"
snapshot "$FORK" "$TMP/fork.json"
snapshot "$LIVE" "$TMP/live.json"
"$PYEXE" - "$TMP/fork.json" "$TMP/live.json" <<'PY'
import json, sys
ja = json.load(open(sys.argv[1], encoding='utf-8'))
jb = json.load(open(sys.argv[2], encoding='utf-8'))
only_f = sorted(ja.keys() - jb.keys())
only_l = sorted(jb.keys() - ja.keys())
diff   = sorted(k for k in ja.keys() & jb.keys() if ja[k] != jb[k])
print(f"现场新增={len(only_l)} fork独有(现场已删)={len(only_f)} 内容不同={len(diff)}")
for x in only_l[:15]: print('  +新增    ', x)
for x in only_f[:15]: print('  ?fork独有 ', x)
for x in diff[:15]:   print('  ~不同    ', x)
PY

if [ "${1:-}" != "--apply" ]; then
  echo ""
  echo ">>> dry-run 结束（未动文件）。确认后执行：bash sync-live-to-fork.sh --apply"
  exit 0
fi

echo ""
echo ">>> [2/3] robocopy 现场 → fork（只覆盖+新增，不删除）"
# ⚠️ node_modules 用目录名排除（不限层级）：pnpm workspace 有 2500+ 嵌套依赖，
#    只排顶层会遍历到被占用的 .js 并每个空等 30 秒（2026-10-11 实测）。
#    /R:1 /W:1 关闭长等待。
XDIR=(node_modules .next .workbuddy data dist test-results playwright-report
      blob-report coverage .git .codegraph .turbo)
XFILE=(tsconfig.tsbuildinfo .env.local _diag.txt rollup.config-*.cjs)
a=("$(w "$LIVE")" "$(w "$FORK")" //E //NFL //NDL //NJH //NP //R:1 //W:1)
for d in "${XDIR[@]}"; do a+=(//XD "$d"); done
for f in "${XFILE[@]}"; do a+=(//XF "$f"); done

rc=0
robocopy "${a[@]}" > "$TMP/rc.txt" 2>&1 || rc=$?
if [ "$rc" -ge 8 ]; then
  echo "❌ robocopy 失败，exit=$rc" >&2; tail -30 "$TMP/rc.txt" >&2; exit 1
fi
echo "robocopy exit=$rc（0-7 均成功）"

echo ""
echo ">>> [3/3] fork 里的未提交变更（待人工审阅后 commit）"
cd "$(w "$FORK")"
git status --short | head -40
echo "..."
echo "共 $(git status --short | wc -l) 个变更。"
echo ""
echo "下一步："
echo "  cd /d/OpenMAIC-fork"
echo "  git add -A && git commit -m '...'"
echo "  git push"