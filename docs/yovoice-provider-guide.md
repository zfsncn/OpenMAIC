# yovoice 本地 TTS provider 接入手册

> 落地：fork commit **`d97914ed`**（22 文件），3002 现役镜像 `f9e369eec724`，真机验收全通过（含真实 GPU 合成 200 WAV）。
> 决策记录：接 **HTTP 同步接口**（`POST /v1/generate` → WAV），**不接 MCP**（其工具返回 `downloadPath` 而非音频本体，且本项目的 provider 契约 = 单次 HTTP 拿字节）。

## 1. 架构

```
浏览器设置面板 ── /api/generate/yovoice-voices (代理) ──┐
浏览器合成请求 ── /api/generate/tts ── yovoice-tts.ts 适配器 ──┤
                                        └──> http://host.docker.internal:8080
                                             （宿主机 yovoice serve / 桌面应用）
                                             POST /v1/generate {text, modelId, voiceId}
                                             → audio/wav
```

- 音色存在 **yovoice 服务端**（非浏览器 IndexedDB），设置面板经代理拉 `GET /v1/voices`、上传样本 `POST /v1/voices?name=`；无删除端点（上游没有）。
- 代理路由**永不使用请求输入的 base URL**（SSRF 纪律同 TTS 路由）：只打内置默认端点，继承操作者的 `ALLOW_LOCAL_NETWORKS` 开关。
- 适配器错误码：`YOVOICE_VOICE_REQUIRED`（路由预检 sentinel）、`YOVOICE_CONFIG_MISSING`、`YOVOICE_BUSY`（409 重试 2 次后）、`YOVOICE_HTTP_ERROR`、`YOVOICE_TIMEOUT`、`YOVOICE_EMPTY_AUDIO`。
- `yovoice` 一次只处理一个任务、不排队；批量配音须串行化（红线 67 路径）。

## 2. 宿主侧准备（一次性）

```sh
# CLI 已装于 C:\Users\zfsnc\yovoice-cli（v0.2.0，在 PATH）；桌面应用 D:\soft\yovoice
# 1) 运行时（GitHub 直连被卡时，用镜像预下载到 <data-dir>\downloads\ 并保留原始文件名）
#    https://ghfast.top/https://github.com/0xShug0/audio.cpp/releases/download/v0.9.1/audio-v0.9.1-bin-windows-x64-cuda12.4.zip
#    https://ghfast.top/https://github.com/0xShug0/audio.cpp/releases/download/v0.9.1/audio-v0.9.1-cudart-windows-x64-cuda12.4.zip
yovoice setup --backend cuda --data-dir D:\soft\yovoice
# 2) 登记模型（免 5GB 重新下载）
yovoice models import D:\soft\yovoice\models\voxcpm2-orig.gguf --data-dir D:\soft\yovoice
# 3) 常驻服务（与桌面应用互斥：同一数据目录同时只能一个进程用）
export YOVOICE_API_TOKEN=$(openssl rand -hex 32)
yovoice serve --data-dir D:\soft\yovoice --listen 127.0.0.1:8080 --generation-timeout 10m
# 4) 上传音色
curl -X POST -H "Authorization: Bearer $YOVOICE_API_TOKEN" \
  -H 'Content-Type: application/octet-stream' --data-binary @voice.wav \
  "http://127.0.0.1:8080/v1/voices?name=20261008"
```

## 3. 3002 侧

- `.workbuddy/secrets/.env.local` 已加 **`ALLOW_LOCAL_NETWORKS=true`**（第 522 行，原本注释）——容器访问宿主回环的护栏开关；改 env 已随 `docker rm -f` 重建生效。
- 设置 › 模型服务 › 语音合成 › **yovoice (本地)**：填访问令牌（Key），baseUrl 留空（用内置 `http://host.docker.internal:8080`；**自行填 baseUrl 会走严格公网策略被 SSRF 拦**）。
- 模型列表 = 已登记 GGUF 家族；默认 `voxcpm2-orig`。
- **「可用模型」芯片是动态的**（commit `6eb45130`）：面板经 `GET /api/generate/yovoice-models` 代理读上游 `/v1/models` 的 `installed` 数组，只显示实际装在 yovoice 数据目录的模型；拉取失败回退显示全列表。若 store 里保存的 modelId 不在 installed 内（如装过 voxcpm2-orig 却存了 voxcpm2-q8），面板打开时自动改写为 `voxcpm2-orig`（或第一个 installed id），治好 `modelRequired` 错配。

## 4. 实测延迟（RTX 2080 Ti + voxcpm2-orig）

| 文本 | 音频时长 | CLI 一次性 | serve 常驻后 |
| --- | --- | --- | --- |
| 12 字 | 2.56s | 9–10.5s（含 ~7s 引擎启动+模型加载） | ≈1–2s |
| 131 字 | 28.48s | 25.8s（RTF≈0.63 含加载） | ≈15–18s |

## 5. 踩坑记录

1. **桌面应用「本机接口」开关无效**（开+重启也不监听 8080）——该安装版没这功能；用 CLI `serve`。
2. **CLI 运行时安装卡 GitHub**：镜像预下载 zip（原始文件名）放入 `downloads\` 后 `setup` 秒过。
3. **`wslrelay.exe` 劫持 127.0.0.1:3002**：Docker Desktop 的旧转发残留（PID 8316）挡在 com.docker.backend（0.0.0.0:3002）前面，宿主 curl 全部 000 挂起；`taskkill` 该 relay 后立即恢复。诊断特征：LAN IP 通、127.0.0.1 不通、容器内 health 正常。
4. **流水线 curl 被沙箱代理 env 污染**（`HTTP_PROXY` 失效代理 → 验证步挂 16 分钟）：重跑加 `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY`。
5. 桌面应用与 `serve` 共用数据目录互斥：接入了 serve 就别同时开桌面应用生成。
6. **`D:\soft\yovoice\yovoice.exe` 是桌面 GUI 二进制（VoiceWorkbench.Desktop），不能拿去跑 `serve`**：无窗口环境下 WPF 崩溃（`InvalidOperationException ... MainWindow`），表现为进程活着但不监听 8080。serve 必须用 **`C:\Users\zfsnc\yovoice-cli\yovoice.exe`**（与 serve-autostart.cmd 一致）。
7. **删除服务端音色没有官方入口**：HTTP API 无 DELETE（实测 404）、CLI 无 voices 子命令。只能文件层操作：停 serve → 备份 → 删 `voices\*.wav` + 从 `state.json` 的 `voices` 数组移除条目 → 重启 serve。列表里的显示名是 `name`（上传文件名），同 id ≠ 同文件：重复上传同一音频会生成多条不同 id 的同名义。

## 6. 音色删除实操记录（2026-10-15）

- 删除了 3 条重复的 `9cacfff39…`（同文件重复上传产生，文件 6843b9d8 / 9dd44577 / 0dc77114）；两条 `20261008`（b3efc9fa / d10ee9a6）在用全保留。
- 备份位置：`D:\soft\yovoice\backup-20261015\`（state.json.bak + 3 个 wav）。
- 验证：`GET /v1/voices` 与 3002 代理均只剩 2 条 20261008；`voxcpm2-orig + b3efc9fa` 真实合成 200 WAV（245KB）。

## 6.1 二次清理：删除全部音色 + 登记 omnivoice-bf16（2026-10-15）

- 应用户要求删除仅剩的两条 `20261008`（b3efc9fa / d10ee9a6），音色池清零；备份 `state.json.before-20261008-delete.bak` + 2 个 wav 同在 `backup-20261015\`。**清零后测试 TTS/配音会 400 `YOVOICE_VOICE_REQUIRED`，直到重新上传参考音频。**
- `models import D:\soft\yovoice\models\omnivoice-bf16.gguf` 登记成功 → installed = `['voxcpm2-orig','omnivoice-bf16']`（该 gguf 文件之前虽在 models 目录但未登记，故面板芯片不出现、生成报 modelRequired）。
- ⚠️ models 目录里**文件存在 ≠ 已安装**：登记表在 state.json，必须 `models import` 才算数。

## 7. 🔴 克隆真相：voiceId 路径默认不生效，须注册表补原文（2026-10-15 实验）

**现象**：用户报告「测试 TTS 不像上传的 20261008 音色」。F0（基频）分析 + 字节比对定位：

| 实验 | 结果 | 结论 |
| --- | --- | --- |
| voxcpm2 HTTP 带 voiceId vs 不带 | 输出**逐字节相同**（307244B） | voiceId 被静默忽略，回退默认音（F0 259Hz） |
| 假 voiceId | 200 不报错 | 上游无校验 |
| voxcpm2 + voiceId + 请求级 `referenceText` | 仍默认音 | 请求级原文救不了 voiceId 路径 |
| CLI `--voice <缩写id>` | 报 `voiceRequired` | 音色 ID 必须传完整 32 位（漏 `--data-dir` 同样报此错） |
| CLI `--reference 文件`（无原文） | 仍默认音 | 纯参考音频克隆不生效 |
| CLI `--reference 文件 + --reference-text 原文` | F0 移向参考音 | ✅ 参考音频路径有效 |
| **CLI `--voice <完整id> --model voxcpm2-orig`（16:35）** | 32s 旁白，**用户 16:39 试听确认 = 本人音色** | ✅✅ **CLI 直连是真克隆** |
| **注册表补 `referenceText` 后 omni + voiceId** | F0 253Hz IQR(212-282) ≈ 参考 255Hz(209-320) | ✅ **omni 真克隆激活** |
| 同法 voxcpm2 | 仍默认音 | voxcpm2 的 HTTP voiceId 路径彻底无效 |

**根因（2026-10-15 晚间最终更正）**：
- 用户盲听裁决 F（11:24 存档）= **100% 本人音色** → 引擎克隆能力没问题。深挖确认：**中午前成功的克隆全部出自 yovoice 桌面应用的内部管线**（service.log 带 `project_id`/`draft.save`，state.backup.json 留有草稿：voxMode=clone、无原文、voiceId=0dc77114），不是 serve 的公开 HTTP 接口。
- **serve 公开 `POST /v1/generate` 存在上游 bug**：voxcpm2 的 `voiceId` 被静默丢弃（带/不带输出逐字节相同；`voxMode`/`mode`/请求级 `referenceText` 均无效），omnivoice 的 voiceId 半生效（产出第三声）。同一份音频、同一引擎，桌面应用管线克隆成功 ⇒ bug 定位在 serve 的 HTTP 层参数传递，不在引擎。
- ✅✅ **CLI 直连克隆实锤（16:39 用户试听确认）**：`yovoice generate --voice <完整32位id> --model voxcpm2-orig --data-dir D:\soft\yovoice` 产出的 `narration-20261008.wav`（32s）被用户确认为本人音色。bug **仅限 serve HTTP 层**；CLI 与桌面应用两条本地路径都能真克隆。 voxcpm2 不支持 `--speed`/`--language`（选项级报错）。
- ⚠️ 排障误判更正：① CLI `--voice` 报 `voiceRequired` 是因为漏了 `--data-dir`（读了默认目录）；② 「引擎必须参考原文才能克隆」结论作废——桌面应用无原文也能克隆（引擎自带 ASR 或 clone 模式自处理）；③ `--reference` 指向不存在的文件时 CLI 静默回退默认音（R1 教训，先确认文件存在）。

**使用结论（3002 侧，最终版 16:40 更正）**：
- serve HTTP 路径下两个模型都产不出目标音色（voxcpm2=默认音、omni=第三声）→ 3002 在线链路上 yovoice 只能作「本地默认音/备用」；**真克隆三条路 = ① CLI 直连（`--voice` 完整 ID + `--data-dir`，本地命令行）② yovoice 桌面应用（本地手动）③ MiMo/CosyVoice（云，3002 在线可用）**。
- 上游 issue 范围（只针对 serve HTTP）：`/v1/generate` voxcpm2 voiceId 被丢弃——证据：A≡C 字节级复现、桌面应用同音色同引擎克隆成功（11:24 project_id 日志 + 用户盲听确认）、omni 半生效对照、**CLI 直连同音色克隆成功（16:39 用户确认）进一步收窄 bug 到 HTTP 参数传递层**。

## 8. 实验记录归档

- 逐字稿：`D:\soft\yovoice\backup-20261015\20261008-transcript.txt`（用户提供，无标点连写）。
- 实验产物：`D:\OpenMAIC\.workbuddy\tmp\clip{A..N}*.wav`、`probe-*.wav`、`f0-analyze.py`（纯 Python F0 分析，无 numpy 依赖）。
- F0 判定基线：参考样本 255Hz(209-320)；voxcpm2 默认音 259Hz；omni 默认音 198Hz；CLI 精细克隆（198Hz 参考）→ 217Hz。



