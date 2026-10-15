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
