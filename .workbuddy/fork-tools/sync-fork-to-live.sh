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
XGLOT = ['packages/*/rollup.config-*.cjs']   # 构建期临时产物，非源码
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
TMP="$(mktemp -d)"
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

echo ""
echo ">>> [2/4] robocopy 镜像 fork → 现场"
XDIR=(node_modules .next .workbuddy data dist test-results playwright-report blob-report .git .codegraph)
args=("$(w "$FORK")" "$(w "$LIVE")" //E //NFL //NDL //NJH //NP)
for d in "${XDIR[@]}"; do args+=(//XD "$(w "$FORK/$d")" "$(w "$LIVE/$d")"); done
for f in tsconfig.tsbuildinfo .env.local _diag.txt; do args+=(//XF "$(w "$FORK/$f")" "$(w "$LIVE/$f")"); done
args+=(//XF 'rollup.config-*.cjs')

# ⚠️ 修复：原写法 `robocopy ... || true; echo $?` 因 $? 被 true 覆盖而恒为 0，
#    robocopy 失败（≥8）会被静默吞掉。正确做法是取到真实返回码再判断。
rc=0
robocopy "${args[@]}" > "$TMP/rc.txt" 2>&1 || rc=$?
if [ "$rc" -ge 8 ]; then
  echo "❌ robocopy 失败，exit=$rc（≥8 即失败）" >&2
  tail -30 "$TMP/rc.txt" >&2
  exit 1
fi
echo "robocopy exit=$rc（0-7 均成功）"

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