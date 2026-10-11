# OpenMAIC fork 跟版与日常开发手册

> 适用仓库：本地 `D:\OpenMAIC-fork`（= GitHub `zfsncn/OpenMAIC` 的 clone）
> 编写日期：2026-10-09 · 配套分析：`docs/upstream-follow-analysis.md`
>
> **三个目录的角色（先记住这张表）**
>
> | 目录 | 角色 | 会被谁改动 |
> |---|---|---|
> | `D:\OpenMAIC-fork` | **开发与版本仓**（git 管理，唯一事实源） | 你 / AI（每轮改造一个 commit） |
> | `D:\OpenMAIC` | **3002 运行现场**（构建镜像的上下文） | 同步自 fork（只读视角使用） |
> | `D:\OpenMAIC-main` | ⚠️ **已退役**（仅历史参考；它 ≠ v1.1.1 tag，真实基线 = upstream `c72a64b4`） | 无人 |

---

## 一、仓库现状（2026-10-09 16:41 交付时点）

```
my-main 分支（本地，尚未推送）：
  c1219ef6  chore: 清基线遗留（-20）
  86615bbc  feat(home): 只列课件投影 + 归属/门禁      ← 你的改造，4 个功能块 commit
  33671686  feat(materials): 抽取归档+章节目录+app_kv
  3e620d6a  feat(classroom): 案例/测验 3 池
  36260411  feat(pdf): AliDocMind 换引擎、删 MinerU
  c72a64b4  ← 基线（upstream commit，feat: Gemini TTS，2026-10-02）
      ↑ 之后上游已有 26 个新 commit（截至 10-09），下次 merge 时一并带入

remote：
  origin   = https://github.com/zfsncn/OpenMAIC.git      （你的 fork，push 目标）
  upstream = https://github.com/THU-MAIC/OpenMAIC.git    （官方，只 fetch 不 push）
```

门控基线（fork 树 16:41 实测）：tsc **0 错** · eslint **0 错**（20 个既有 warning）·
vitest 822 通过 / **5 个失败文件与本底现场同签名**（`tests/ci/publish-openmaic-skill` ·
`tests/ci/check-clawhub-version` · `tests/agent-runtime/chart-schema-lockstep` ·
`tests/media/media-placeholder-lease-guard` 1 例 · `tests/video-export/cover-card-layout.browser`）
⇒ **这 5 个失败是本底环境性的，判"跟版是否引入新问题"时把它们排除在外即可**。

---

## 二、第一次 push（待办 ①：把改造备份上云）

### 为什么现在做

`my-main` 目前只存在你本机一块硬盘上。推到 GitHub 后：云端备份 + 换电脑可用 +
以后能开 Pull Request 回上游（如果愿意）。

### 步骤（PowerShell 或 Git Bash，在任意目录执行）

```bash
cd /d/OpenMAIC-fork
git push -u origin my-main
```

**第一次会弹认证**，按你遇到的情况选一种：

| 弹出什么 | 怎么做 |
|---|---|
| **浏览器打开 GitHub 授权页**（Windows 凭据管理器模式，最常见） | 点 "Authorize"，回到终端自动继续。凭据会存住，以后不再弹 |
| 终端提示 `Username / Password` | Username 填 `zfsncn`；**Password 处粘贴 Personal Access Token**（不是账号密码！GitHub 已不接受密码） |
| `could not read Username`（无凭据助手） | 见下方"配置 PAT"小节 |

### 配置 Personal Access Token（PAT，一次性 2 分钟）

1. 浏览器打开 https://github.com/settings/tokens → **Generate new token (classic)**
2. 勾选 `repo` 权限（其余可不勾），生成后**立即复制**（只显示一次）
3. 让 git 记住它（Git Bash）：

```bash
git config --global credential.helper manager      # Windows 推荐（凭据管理器）
# 或 credential.helper store（明文存 ~/.git-credentials，不推荐但简单）
git push -u origin my-main
# Username: zfsncn
# Password: <粘贴 PAT>
```

### 推完验收

```bash
git push -u origin my-main 2>&1 | tail -3
# 期望出现:  * [new branch]  my-main -> my-main
```

浏览器打开 `https://github.com/zfsncn/OpenMAIC/tree/my-main` 应能看到 `部署教程.md`、
`lib/utils/courseware.ts` 等。✅ 此后**每次重要 commit 后 `git push` 一下**即可保持云端同步。

---

## 三、日常开发：两种工作流（待办 ②：二选一）

### 工作流 A（推荐）：改在 fork，同步到现场

> 改造发生在 git 仓内，天然有 commit 记录、可回滚、可 diff；现场只是构建镜像的"部署出口"。

```
┌─────────────────┐   改代码+commit    ┌─────────────────┐   同步(§3.1)   ┌──────────────┐
│ D:\OpenMAIC-fork │ ────────────────→ │ D:\OpenMAIC      │ ────────────→ │ docker build │
│   (git 事实源)    │                   │  (3002 现场)     │                │  3002 上线    │
└─────────────────┘                    └─────────────────┘                └──────────────┘
```

**每轮改造的完整动作：**

```bash
# ① 改代码（在 fork 里改）
cd /d/OpenMAIC-fork
#    ...编辑文件...

# ② 本仓自检（快，改坏立刻发现）
export PATH="/c/Users/zfsnc/.workbuddy/binaries/node/versions/22.22.2-6:/d/soft/nodejs:$PATH"
pnpm exec tsc --noEmit
pnpm exec vitest run --testTimeout=30000 <你改动相关的测试文件>

# ③ 提交（一个功能点一个 commit）
git add -A && git commit -m "feat(模块): 干了什么"

# ④ 同步 → 门控 → 构建 → 部署 → 验收（一条命令，推荐）
bash .workbuddy/fork-tools/pipeline.sh --apply

# ⑤ 推云端（随手）
git push
```

> **推荐用 `pipeline.sh --apply` 代替手工串 ④**。它把「同步 → tsc 门控 → docker build
> → 重建容器 → 验收」串成一条命令，并自带护栏与回滚标签。手工分步时任何一步漏掉都容易出错。
>
> ```bash
> bash .workbuddy/fork-tools/pipeline.sh              # dry-run：只看将要发生什么，不动任何东西
> bash .workbuddy/fork-tools/pipeline.sh --apply      # 真跑全流程
> bash .workbuddy/fork-tools/pipeline.sh --apply --prune        # 同步时删除 fork 已删的源码
> bash .workbuddy/fork-tools/pipeline.sh --apply --no-build     # 只同步+部署，沿用现役镜像
> bash .workbuddy/fork-tools/pipeline.sh --apply --tag my-标签  # 自定义回滚标签后缀
> ```
>
> **四道护栏**（任一触发即中止，不会把半成品带进镜像）：
> 1. 源码树根出现 `.env.local` ⇒ 拒绝执行（会被打进镜像层，泄漏密钥）
> 2. fork 工作树有未提交改动 ⇒ 拒绝同步（现场会拿到半成品）
> 3. tsc 有错误 ⇒ 中止，不 build、不动容器
> 4. 验收含「容器镜像 == 刚构建镜像」断言 + 查库确认数据未丢、数据与流水线开始前一致
>
> **自动回滚标签**：每次真跑前自动 `docker tag` 现役镜像为 `openmaic-new:pre-<tag>`，
> 回滚：`docker tag openmaic-new:pre-<tag> openmaic-new:latest && bash .workbuddy/deploy/start-3002.sh --run`
>
> ⚠️ **流水线只改代码、不改数据**，也不碰 3003/3006。DB 变更须单独授权并先`pg_dump`。

### 3.1 fork → 现场同步脚本（已备好）

>脚本的 Git 事实源在 **fork 仓**（`.workbuddy/fork-tools/`，已纳入版本管理）；
> `D:\OpenMAIC\.workbuddy\fork-tools\` 是运行时副本，改动后需两边同步。

```bash
# 从 fork 目录（推荐，事实源）
bash .workbuddy/fork-tools/sync-fork-to-live.sh            # 先看差异（dry-run）
bash .workbuddy/fork-tools/sync-fork-to-live.sh --apply    # 真正同步
bash .workbuddy/fork-tools/sync-fork-to-live.sh --apply-prune  # 同步并删除 fork 已删的源码
```

原理：robocopy 镜像（排除 node_modules/.next/.workbuddy/data/dist 等运行态），
**同步后自动跑"漂移校验"**——md5 全量比对两树，报告"仅现场/仅 fork/内容不同"三个数，
非 0 会红色告警。**现场树里只有构建产物和运行数据是合法差异**，其余都该为 0。

**为什么 `--apply` 和 `--apply-prune` 要分开**：`--apply` 只做覆盖+新增，
**不删除**任何文件（安全，但 fork 里删掉的源码会残留在现场、导致漂移校验报「仅现场>0」）。
确认删除是有意为之后，用 `--apply-prune` 才会真正删。

**已知坑（都已修复，勿回退）**：
- `node_modules` 必须用**目录名**排除（不限层级）。本仓库是 pnpm workspace，
  嵌套依赖有 2500+ 个；只排顶层会让 robocopy 遍历到被占用的 `.js`，
  每个文件空等 30 秒——单文件就能把整轮同步拖到 12 分钟（2026-10-11 实测）。
- robocopy 必须取真实返回码判断成败：`robocopy ... || rc=$?`。
  写成 `|| true; echo $?` 会让 `$?`恒为 0，失败被静默吞掉。

### 工作流 B：改在现场，定期回灌 fork

> 适合"随手小改、先看效果再沉淀"的用法。风险是现场改动**没有版本控制**，回灌前宕机就丢。

```bash
# 现场改完、验收 OK 后，回灌进 fork：
bash /d/OpenMAIC/.workbuddy/fork-tools/sync-live-to-fork.sh
# 脚本会：robocopy 现场→fork（同上排除）→ git status 展示变更 → 你确认后 AI 帮你分组 commit
```

⚠️ 工作流 B 的铁律：**回灌间隔别超过几天**。现场树没有 git，漂移越大、回灌时越难说清"哪处改动属于哪轮需求"。

### 两种工作流怎么选

| 场景 | 用哪种 |
|---|---|
| 有明确需求单（如"加 XX 功能"）、要动多个文件 | **A** |
| 调 CSS/文案、试一行效果 | B（改现场直接刷新看），验收后立刻回灌 |
| 动 `lib/`、`packages/`、API 路由 | **必须 A**（这些是跟版冲突高危区，必须在 git 里改） |

---

## 四、上游跟版（核心场景：官方发新版本后）

### 4.1 判断要不要跟

```bash
cd /d/OpenMAIC-fork
git fetch upstream --tags
git tag --sort=-creatordate | head -8        # 看最新 tag
git log --oneline c72a64b4..upstream/main | head -20   # 看 main 上有什么新东西
```

**跟版原则**：只跟 **stable tag**（`v1.2.0` ✅，`v1.2.0-rc.1` ❌）；每 1–2 个 minor 跟一次即可，
不必每个小版本都追。跟之前扫一眼上游 CHANGELOG 的 **Breaking Changes** 段——
若涉及 DB schema（`packages/@openmaic/storage`）或 `/api/persistence`，先看 §4.4 的数据库警告。

### 4.2 标准跟版流程（以 v1.2.0 为例）

```bash
cd /d/OpenMAIC-fork

# ① 取新版本
git fetch upstream tag v1.2.0

# ② 预演冲突（不真合并，先看会撞哪里）
git merge --no-commit --no-ff v1.2.0 2>&1 | grep -E "CONFLICT" | sort
git merge --abort          # 看完就撤

# ③ 真合并
git merge v1.2.0
```

### 4.3 解冲突守则（冲突只会出现在"两边都改过"的文件）

```bash
git status                          # 列出所有冲突文件
git diff <冲突文件>                  # 逐个看 <<<<<<< / ======= / >>>>>>> 区块
```

| 冲突区块里是什么 | 怎么解 |
|---|---|
| **你的功能代码**（case-variants、courseware 过滤、AliDocMind 调用、app_kv…） | **保留你的**，并把上游的新逻辑接进来（通常两者在不同函数，都要留） |
| **上游的重构**（如 provider 注册表、validators 结构） | 以上游骨架为准，把你的功能点**重新插回新骨架**（对照 `docs/` 里该功能的分析文档找"当年为什么这么改"） |
| `.env.example` / i18n 12 locale / CI workflow | 机械合并：两边的新键/新条目都保留 |
| 拿不准 | **停下问我**，把冲突文件路径发我 |

解完：

```bash
git add -A
git commit                            # 完成 merge commit

# 门控三关（缺一不可，红线 7）
pnpm exec tsc --noEmit
pnpm exec vitest run --testTimeout=30000
pnpm exec eslint .

# ⚠️ vitest 判读基准：只允许那 5 个本底失败文件红；
#    出现其它失败 = 跟版引入的回归，先修再继续。
```

### 4.4 数据库兼容性警告（跟版最容易翻车的点）

你的生产库由**你的 fork** 的 `ensureSchema` 管理。若上游改了 `@openmaic/storage` 的建表/索引逻辑：

1. `ensureSchema` 通常**只建新表、不改旧表** —— 大多向前兼容，但**不保证**；
2. 跟版后**先用临时库试启**（不碰三端生产库）：
   ```bash
   docker run -d --name oa-upgrade-test -e POSTGRES_PASSWORD=x -e POSTGRES_DB=openmaic postgres:16
   # 用新镜像 + 指向这个测试库起一个临时 app 容器，看启动日志有无 schema 报错
   ```
3. 上游 CHANGELOG 若写了迁移 SQL（如历史上有过 `UPDATE document_stages ... SET owner_id ...`），**先备份三端库再执行**；
4. 跟版后 3002 真机验收重点：首页列表、上传 PDF→解析、生成课程、案例/测验按钮复用、课堂页配音——这些是你全部改造面的"冒烟清单"。

### 4.5 跟版完成后

```bash
git push                                        # 云端备份
git tag fork-v1.2.0-1 && git push origin fork-v1.2.0-1   # 给自己打版本标（可选但推荐）
# 重打源码包 + 镜像 tar（找 AI，说"重打 OpenMAIC-VN"）
# 三端同步：按老规矩，等你明确要求后才做
```

---

## 五、应急回滚

| 想撤什么 | 命令 |
|---|---|
| 撤销**未提交**的工作区改动（fork 里） | `git checkout -- <文件>` 或 `git restore .` |
| 撤销**最近一次 commit**（保留改动） | `git reset --soft HEAD~1` |
| 撤销最近一次 commit（**连改动一起丢**，慎用） | `git reset --hard HEAD~1` |
| 回到跟版前 | `git reset --hard <跟版前最后一个commit的hash>`（merge 前先 `git rev-parse HEAD` 记下来） |
| 现场树被搞乱，想恢复成 fork 的样子 | `bash .workbuddy/fork-tools/sync-fork-to-live.sh --apply` |
| 3002 容器异常 | 回滚锚点体系（`.workbuddy/rollback/`），与 git 无关，照旧 |

> ⚠️ `git reset --hard` / `git clean` 只作用在 **fork 仓**，碰不到 `D:\OpenMAIC` 现场和 3002 数据库 —— 这是分目录的好处。

---

## 六、常用命令速查

```bash
# —— 环境（每次开新终端先做）——
export PATH="/c/Users/zfsnc/.workbuddy/binaries/node/versions/22.22.2-6:/d/soft/nodejs:$PATH"

# —— 仓库状态 ——
git -C /d/OpenMAIC-fork log --oneline -10        # 最近提交
git -C /d/OpenMAIC-fork status -s                # 工作区是否干净
git -C /d/OpenMAIC-fork remote -v                # 两个 remote

# —— 上游动向 ——
git -C /d/OpenMAIC-fork fetch upstream --tags
git -C /d/OpenMAIC-fork log --oneline my-main..upstream/main | head   # 落后上游多少

# —— 同步（AI 已备好的脚本）——
bash /d/OpenMAIC/.workbuddy/fork-tools/sync-fork-to-live.sh          # fork → 现场
bash /d/OpenMAIC/.workbuddy/fork-tools/sync-live-to-fork.sh          # 现场 → fork

# —— 门控 ——
pnpm exec tsc --noEmit
pnpm exec vitest run --testTimeout=30000
pnpm exec eslint .
```

---

## 七、给 AI 的上下文（每次新会话贴这段即可）

> 项目 = OpenMAIC 三端部署（3002 本机/3003 Debian/3006 腾讯云）。
> 版本仓 = `D:\OpenMAIC-fork`（分支 `my-main`，origin=zfsncn/OpenMAIC，upstream=THU-MAIC/OpenMAIC，
> 基线 commit `c72a64b4`）；`D:\OpenMAIC` = 3002 运行现场（由 fork 同步）；`D:\OpenMAIC-main` 已退役。
> 改造四大块：PDF AliDocMind 换引擎、案例教学+单元测试 3 池、材料归档+章节目录+app_kv、
> 首页侧栏只列课件。跟版手册 = `docs/fork-workflow-guide.md`；门控 = tsc/vitest(--testTimeout=30000)/eslint，
> vitest 有 5 个本底失败文件（见手册 §一）。改 env 只改 `.workbuddy/secrets/.env.local`；
> 三端同步必须我明确要求后才做。

---

*手册版本：2026-10-09 · 随首次 push 与首次真实跟版后回填经验*
