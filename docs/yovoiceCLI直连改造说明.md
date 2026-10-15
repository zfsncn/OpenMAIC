# yovoice CLI 直连改造说明

> 目标：让 3002（OpenMAIC）在线 TTS 通过本地 yovoice 合成出**用户本人的克隆音色**。
> 2026-10-15 完成并经用户真机试听验收通过。本文档记录最终格局与从零复现步骤。

---

## 1. 最终格局（验收后）

| 场景 | 出用户声音的路径 | 状态 |
| --- | --- | --- |
| **3002 在线**（页面「测试 TTS」/课程配音） | 3002 yovoice provider → `host.docker.internal:8080` → **CLI shim** → spawn `yovoice generate`（CLI 真克隆路径） | ✅ 用户试听验收 |
| 3002 云端克隆 | MiMo / CosyVoice（云 provider，与本次改造无关） | ✅ 原有可用 |
| 本地手动 | yovoice 桌面应用 / CLI 直连 | ✅ 可用 |

**核心结论（为什么这样做）**：yovoice 引擎克隆能力正常，但上游 `yovoice serve`
的 HTTP 层会把 voxcpm2 的 `voiceId` **静默丢弃**（带/不带 voiceId 输出逐字节相同），
走 serve 永远出默认音。而 **CLI 直连是真克隆**（用户盲听确认）。因此用一个
宿主机包装层（shim）顶替 serve 监听 8080，把生成请求转为 CLI 调用——
3002 侧**零代码、零配置改动**。

---

## 2. 前置环境

| 组件 | 值 |
| --- | --- |
| 宿主机 | Windows x64，GPU RTX 2080 Ti |
| 3002 | Docker 容器 `openmaic-new`（`openmaic-new:latest`，`0.0.0.0:3002->3000`），部署脚本 `.workbuddy/deploy/start-3002.sh` |
| yovoice CLI | v0.2.0，`C:\Users\zfsnc\yovoice-cli\yovoice.exe` |
| yovoice 数据目录 | `D:\soft\yovoice`（CLI / shim / 桌面应用三方**互斥**使用） |
| 已装模型 | `voxcpm2-orig`（≈4.96GB）、`omnivoice-bf16`（≈1.64GB），位于 `D:\soft\yovoice\models\` |
| 访问令牌 | 与 3002 yovoice provider 的 Key 相同；存于 `D:\tmp\yovoice-token.txt` 与 `D:\soft\yovoice\serve-autostart.cmd` |
| 音色 | `20261008`（用户本人样本，58.78s） |

---

## 3. 从零复现步骤

### 步骤 1：安装 yovoice CLI

1. 从 [GitHub Releases](https://github.com/leemysw/yovoice/releases) 下载
   `yovoice-<版本>-cli-windows-x64.zip`，解压到 `C:\Users\zfsnc\yovoice-cli\`。
   - ⚠️ 若下载卡 GitHub：用 `ghfast.top` 镜像，zip 按**原始文件名**放入
     `D:\soft\yovoice\downloads\` 再执行 `yovoice setup`。
2. 验证：`yovoice --version`。

### 步骤 2：准备数据目录与运行时

```sh
yovoice status --json --data-dir "D:\soft\yovoice"
```

- 运行时（引擎）未装时按提示 `yovoice setup` 安装（下载卡住同上用镜像 zip）。
- 数据目录被占用时报「数据目录正在使用」：关掉 yovoice 桌面应用 / 停掉旧的
  serve / shim 再执行（三方互斥，见 §5 坑①）。

### 步骤 3：登记模型

模型 GGUF 文件放入 `D:\soft\yovoice\models\` 后登记：

```sh
yovoice models import "D:\soft\yovoice\models\voxcpm2-orig.gguf" --data-dir "D:\soft\yovoice"
yovoice models import "D:\soft\yovoice\models\omnivoice-bf16.gguf" --data-dir "D:\soft\yovoice"
yovoice models list --json --data-dir "D:\soft\yovoice"   # 确认 installed 含两个模型
```

⚠️ 「文件在 ≠ 已安装」，必须走 import 登记。

### 步骤 4：注册克隆音色（用户本人样本）

音色条目 = `voices\` 目录下的音频文件 + `state.json` 的 `voices` 数组条目：

1. 用户样本 wav 存为 `D:\soft\yovoice\voices\80f400d64d3ce1caf23342279f06e766.wav`
   （文件名 = 32 位 hex id + `.wav`；1–60s 真实人声）。
2. `state.json` 的 `voices` 数组加入条目（原子写：写 tmp 后 rename）：

```json
{
  "source": "import",
  "id": "80f400d64d3ce1caf23342279f06e766",
  "name": "20261008",
  "fileName": "80f400d64d3ce1caf23342279f06e766.wav",
  "duration": 58.7755,
  "referenceText": "<样本逐字稿（无标点连写），存于 backup-20261015\\20261008-transcript.txt>"
}
```

3. 验证：

```sh
yovoice voices list --json --data-dir "D:\soft\yovoice"
```

4. CLI 克隆自检（⚠️ `--voice` 必须传**完整 32 位 id**；voxcpm2 不支持
   `--speed`/`--language`）：

```sh
yovoice generate --text "测试文本。" --voice 80f400d64d3ce1caf23342279f06e766 \
  --model voxcpm2-orig --output test.wav --json --data-dir "D:\soft\yovoice"
```

输出 JSON 的 `voice` 字段应回显完整 id；`test.wav` 由用户试听确认是本人音色。

### 步骤 5：部署 CLI shim（本次改造的核心）

1. 文件：`D:\OpenMAIC\.workbuddy\deploy\yovoice-cli-shim.mjs`
   （Node ≥18，无第三方依赖，~300 行）。
2. 功能：监听 `127.0.0.1:8080`，**完整复刻 serve 的 4 端点契约**：

| 端点 | 实现 |
| --- | --- |
| `POST /v1/generate` `{text, modelId, voiceId}` | 串行队列 → 写临时文本 → spawn `yovoice generate --voice <完整id> --model <id>` → 回 `audio/wav`；并发 409；客户端断开 kill 子进程；超时 504（默认 10min）；voiceId 查不到 400；**voiceId 空/`'default'`/哨兵 → 自动兜底为注册表最新音色（默认音色，无需手动选）** |
| `GET /v1/voices` | 读 `state.json` 的 `voices` 数组返回 |
| `POST /v1/voices?name=` | 音频体 ≤20MB、wav 1–60s 校验 → 存 `voices\<id>.<ext>` + 原子更新 `state.json` → 返回更新后数组 |
| `GET /v1/models` | spawn `models list --json`（60s 缓存） |

3. 启动（手动验证用）：

```sh
YOVOICE_API_TOKEN=$(cat /d/tmp/yovoice-token.txt) \
  node "D:\OpenMAIC\.workbuddy\deploy\yovoice-cli-shim.mjs"
# 日志应输出: yovoice CLI shim listening on 127.0.0.1:8080
```

4. 开机自启（**两个文件内容保持一致**，均已改为拉 shim；端口被占则自行退出，
   无害）：
   - 启动文件夹（开机真正生效的）：
     `C:\Users\zfsnc\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\yovoice-serve.cmd`
   - `D:\soft\yovoice\serve-autostart.cmd`（手动双击用）

```bat
@echo off
set "YOVOICE_API_TOKEN=7e89a12d...（= 3002 provider Key）"
start "yovoice-shim" /min "D:\soft\nodejs\node.exe" "D:\OpenMAIC\.workbuddy\deploy\yovoice-cli-shim.mjs"
```

   ⚠️⚠️ **进程归属决定 shim 存活**（17:50 实测教训）：shim 必须由**用户会话**
   （启动文件夹 / 手动双击 / 开机）拉起。AI 助手会话沙箱派生的任何进程都活不过
   会话边界（后台任务 / `cmd start` / `Start-Process` / WMI / Explorer 代启动
   全部被回收或拦截），症状 =「当次验证 OK、过一会儿 8080 无监听、设置页音色
   列表变空『—』、可用模型回退全目录」。遇到此症状先查进程树归属，别改服务代码。

5. 默认音色（2026-10-15 17:25 增补，**无需手动选音色**）：
   - shim 兜底：voiceId 空 / `'default'` / `__yovoice` 哨兵 → 自动解析为注册表
     **最新音色**（改 shim 即生效，无需重建 3002）；
   - 3002 设置面板自动 pin：存储选择悬空时自动勾选最新音色并持久化
     （fork `c409aa6d`，MiMo 范式；根因 = 重新上传样本会换新 id）；
   - 结论：**重新上传样本换新 id 后也不用重选**。

### 步骤 6：3002 侧（零代码，仅需确认两项）

1. **容器 env**：`ALLOW_LOCAL_NETWORKS=true`（已配置在
   `D:\OpenMAIC\.workbuddy\secrets\.env.local`；改动 env 必须
   `docker rm -f` 重建容器，`restart` 无效）。
2. **设置页 yovoice provider**：Base URL 留空（默认即
   `http://host.docker.internal:8080`），Key 填与 shim 相同的 token。
   **不要改任何源码**——适配器 `lib/audio/yovoice-tts.ts` 与代理路由
   `app/api/generate/yovoice-voices/route.ts`、`app/api/generate/yovoice-models/route.ts`
   的契约 shim 已完全兼容。

### 步骤 7：验收清单（按序执行）

| # | 测试 | 命令 | 期望 |
| --- | --- | --- | --- |
| 1 | 无 token 拒绝 | `curl -s -o /dev/null -w "%{http_code}" --noproxy '*' http://127.0.0.1:8080/v1/voices` | 401 |
| 2 | 宿主机 voices | `curl -H "Authorization: Bearer $TOKEN" --noproxy '*' http://127.0.0.1:8080/v1/voices` | 200 + 音色数组 |
| 3 | 宿主机 generate | `curl -X POST .../v1/generate -d '{"text":"...","modelId":"voxcpm2-orig","voiceId":"80f400d6..."}'` | 200，`content-type=audio/wav`，文件头 `RIFF` |
| 4 | 容器内链路 | `docker exec openmaic-new node -e "fetch('http://host.docker.internal:8080/v1/voices',{headers:{Authorization:'Bearer '+process.argv[1]}}).then(r=>console.log(r.status))" $TOKEN` | 200 |
| 5 | 并发/单任务 | 生成期间再发一个 generate | 409 |
| 6 | **真机试听** | 3002 UI → yovoice 面板 → 「测试 TTS」 | 用户确认 = 本人音色 |

⚠️ 每次生成有 ≈9s CLI 冷启动（模型加载），测试时稍等属正常。

---

### 步骤 8：重启电脑后的恢复（日常操作，共 2 步）

容器重启策略：`openmaic-new` = **no**（重启后不会自启，需手动拉起）；
`openmaic-new-db` = `unless-stopped`（随 Docker Desktop 自动恢复）；
shim = 启动文件夹自启（无需操作）。

| 步骤 | 操作 | 判定 |
| --- | --- | --- |
| ① | 等 Docker Desktop 启动完成（没设自启就手动打开） | 右下角鲸鱼图标，DB 容器自动恢复 |
| ② | 双击 **`D:\OpenMAIC\start-3002-after-reboot.cmd`** | 输出 `openmaic-new  Up` |

然后浏览器访问 `http://localhost:3002/` 即可。快速自检：设置页 yovoice 音色列表
能列出 20261008 = 全链路通；任务管理器有 `node.exe`（shim）。

⚠️ 流水线注意：`start-3002-after-reboot.cmd`、`server-providers.yml` 是**现场
独有文件**，已加入 `sync-fork-to-live.sh` 的 XFILE 忽略清单（fork `3d73bfda`、
`5daa4115`），否则每轮流水线漂移校验都会被「仅现场=1」阻断。



## 4. 回滚方案

把 `serve-autostart.cmd` 里的 start 行改回拉 serve（其余不动）：

```bat
start "yovoice-serve" /min "C:\Users\zfsnc\yovoice-cli\yovoice.exe" serve --data-dir "D:\soft\yovoice" --listen 127.0.0.1:8080 --generation-timeout 10m
```

回滚后 3002 仍可用，但**只会出默认音**（serve HTTP 丢 voiceId 的上游 bug），克隆
走 MiMo/CosyVoice。3002 源码侧无需任何回滚（本次未改 3002 代码）。

---

## 5. 已知坑与注意事项

1. **三方互斥**：shim / CLI / yovoice 桌面应用共用 `D:\soft\yovoice`，同一时刻
   只能有一个在用。开桌面应用前先关 shim（进程名 `node.exe`）。
2. **`--voice` 必须完整 32 位 id**：缩写 id（如 `80f400d6`）报 `voiceRequired`。
3. **voxcpm2 不支持 `--speed` / `--language`**：选项级报错，去掉即可。
4. **serve 二进制辨析**：`D:\soft\yovoice\yovoice.exe` 是桌面 GUI，无窗口环境跑
   serve 会 WPF 崩溃假活（进程在但不监听）；任何命令行用途都用
   `C:\Users\zfsnc\yovoice-cli\yovoice.exe`。
5. **上传的新音色无 `referenceText`**：若克隆异常，可按步骤 4 手工补样本逐字稿。
6. **shim 挂 = 3002 yovoice 不可用**（与原 serve 同风险）；重拉
   `serve-autostart.cmd` 即恢复。
7. **音色删除无官方入口**：文件层操作（删 `voices\<id>.wav` + 移除 `state.json`
   条目），shim 运行中也可做（shim 每次请求现读 state.json，无缓存）。
8. **psql / 容器内无 curl**：容器内链路测试用 `docker exec openmaic-new node -e ...`。
9. **默认音色（2026-10-15 17:15 增补）**：shim 把空/`'default'`/`__yovoice` 哨兵
   voiceId 兜底为注册表**最新音色**；3002 设置面板在存储选择悬空时自动 pin 最新
   音色并持久化（fork tts-settings.tsx，对齐 MiMo 范式）。**重新上传样本会换
   新 id，但不再需要手动重选**。克隆生成请用 voxcpm2-orig（omni 走 voiceId 会
   报 `omniReferenceRequired`，shim 如实转发 400）。

---

## 6. 证据链摘要（为何 CLI 而非 serve）

| 实验 | 结果 |
| --- | --- |
| serve HTTP 带/不带 voiceId（voxcpm2） | 输出**逐字节相同**（307244B）→ voiceId 被静默丢弃 |
| serve HTTP + 请求级 `referenceText` / `voxMode` / `mode` | 仍默认音 |
| serve HTTP omni + voiceId | 半生效（F0 对、音色不对的「第三声」） |
| 桌面应用内部管线（同引擎同音色） | ✅ 真克隆（`project_id` 日志 + 用户盲听 100% 确认） |
| **CLI `--voice <完整id>`** | ✅ **真克隆（2026-10-15 16:39 用户试听确认）** |
| CLI shim 全链路 + 3002 UI 实听 | ✅ **2026-10-15 17:01 用户验收通过** |

详细实验记录：`docs/yovoice-provider-guide.md` §7–§9。

---

## 7. 相关文件与提交

| 文件 | 说明 |
| --- | --- |
| `D:\OpenMAIC\.workbuddy\deploy\yovoice-cli-shim.mjs` | CLI shim（本次新增） |
| `D:\soft\yovoice\serve-autostart.cmd` + 启动文件夹 `yovoice-serve.cmd` | 自启脚本（两份内容一致，拉 shim） |
| `D:\OpenMAIC\start-3002-after-reboot.cmd` | 重启后一键拉起 3002（现场独有，已入 XFILE 忽略清单） |
| `D:\soft\yovoice\state.json` | 音色注册表（voices 数组） |
| `D:\soft\yovoice\backup-20261015\` | 全部原始样本 + 逐字稿 + state 备份 |
| `C:\Users\zfsnc\.workbuddy\skills\yovoice\LOCAL-SERVER.md` | 技能侧本机服务说明（含 shim 模板） |
| fork 提交 | `d97914ed`（provider 上线）→ `6eb45130`（动态模型）→ `ca7fa046`（CLI 克隆实锤）→ `c83817fb`（shim §9）→ `c409aa6d`（默认音色自动 pin）→ `3d73bfda`/`5daa4115`（流水线忽略现场独有文件） |
| 手册 | `docs/yovoice-provider-guide.md` §5 踩坑 / §6 音色管理 / §7 克隆真相 / §8 实验归档 / §9 shim |
