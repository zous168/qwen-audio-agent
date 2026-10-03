# Vidu S 实时数字人接入 qwen-audio-agent 技术说明

| 项目 | 说明 |
| --- | --- |
| 状态 | 共用主界面、网关编排、WebRTC 视频下行和 Vidu 协议适配已实现；厂商 RTC 桥及云端实测待完成 |
| 适用版本 | qwen-audio-agent 2.x（WebRTC 扩展 + DashScope Realtime） |
| Vidu 形态 | **S2 Avatar 组件版（外接直播）** |
| 官方协议 | [实时交互数字人-组件版](https://platform.vidu.cn/docs/vidu-s1-1) |

---

## 1. 文档目的

### 当前产品入口（2026-10-03）

日常使用入口是主 Gateway 的 `/`。桌面对话面板和 Web 使用同一份 React 应用；主界面的「对话形象」选择器可切换语音与已配置的数字人。桌面悬浮球显示同一个下行视频流。`/api/realtime/webrtc/example` 保留为开发诊断页。

- 语音模式使用现有 WSS；数字人模式将同一套 Gateway Client Protocol 放到 WebRTC DataChannel 上，音视频输出走 RTP。麦克风、唤醒词、图片输入仍由共用客户端控制。
- 会话 ID、历史恢复、任务命令、权限、桌面工具及休眠状态仍由原 Gateway Runtime 管理。切换形象会中断当前回复并重连呈现通道。
- 数字人出声前失败，会回放缓存的 Qwen 原声；出声后失败会停止当轮，后续回复使用原声。RTC 连接失败会退回 WSS，可手动重连数字人。
- `/api/digital-human` 仅返回形象 ID、名称和可用状态，受 Gateway 认证保护。Vidu Key、RTC Token 和服务端模块路径不下发给 Web 主界面。
- 本机服务端参数通过桌面「设置 → 数字人」配置；连接远端 Gateway 时由该服务器管理员配置。Web 主界面负责形象选择和状态显示，目前不提供远端密钥编辑。

自动化已覆盖真实 Chromium 中的 Web/桌面面板、RTC 音视频收发、单活动会话、字幕、切回语音、媒体进程故障和降级。测试用模拟数字人媒体源。仓库提供 RTC 桥接口和加载器，尚未内置任何厂商 RTC 接收 SDK；真实 Vidu 口型、端到端延迟和计费须在配置对应 RTC 桥及真实凭据后验收。

本轮功能与代码审核修复了断线后旧回调污染新回复、出声前降级丢失原声、视频帧过早取消音频超时，以及 Windows 原生 RTC 的位深元数据异常导致断线等问题。针对性回归共 56 项通过，包括 Audio/Omni 各连续连接三次、共用 Web/桌面面板的真实 RTP 测试；构建、ESLint 和差异格式检查通过。桌面面板自动化使用 Chromium，原生 Electron 的系统权限和真实厂商媒体仍需后续联调。

验证命令（PowerShell）：

```powershell
npm run build --workspace web
$env:QWAUDIO_TEST_WEBRTC_NATIVE = '1'
node --test --test-concurrency=1 server/test/digital-human-app-native.test.mjs server/test/webrtc-native.test.mjs
```

缺少密钥时可先预览整体界面（不会建立云端语音或数字人会话）：

```powershell
$env:QWEN_AUDIO_ALLOW_UNCONFIGURED = '1'
npm start --workspace desktop
```

桌面会管理唯一的本机 Gateway，同时打开设置；Web 访问该 Gateway 的 `/` 即为同一产品界面。已有其他命令启动的 Gateway 时，先停止该进程，再用桌面启动，以便本机参数保存后能自动重启生效。正常使用不需要设置此预览变量。

### 设计说明

说明如何在 **不替换 Qwen Realtime 对话栈** 的前提下，用 Vidu S 承担 **实时数字人渲染与推流**，并与 qwen-audio-agent 现有的网关、WebRTC、呈现运行时协同。

本文面向：

- 要在 `qwen-audio-agent` 上落地 Vidu 的开发者；
- 需要评估工作量与边界的架构/产品同学。

**不在本文范围**：Vidu 完整版（Vidu 自带 ASR/LLM/TTS）、离线数字人 MP4、S2-Editing 实时换脸换装（可另开文档）。

---

## 2. 方向结论（能否配合）

**可以配合，且职责划分清晰。**

| 层级 | 负责方 | 职责 |
| --- | --- | --- |
| 听、想、说、工具、记忆、打断、内容安全 | qwen-audio-agent + Qwen Realtime | 不变 |
| 口型、表情、形象、数字人音视频推流 | Vidu S 组件版 | 只吃助手侧输出 + 双端转写 |
| 用户浏览器 ↔ 网关 | 现有 WebRTC / WSS | 麦克风上行；数字人模式下增加视频下行 |
| 厂商密钥、Vidu 会话 | 网关服务端 | 客户端不持有 `vda_` Key |

这不是「两个 Agent 并联」，而是 **同一轮对话、两种呈现**（纯音频 vs 数字人音视频）。工程上需要 SPI、RTC 桥、播放策略等开发，属于正常落地成本，不是架构冲突。

---

## 3. 为什么选组件版，不选完整版

Vidu S 提供两条实时数字人路线：

| | 组件版（外接直播） | 完整版（托管 Live） |
| --- | --- | --- |
| ASR / LLM / TTS | **客户自备**（qwen 已具备） | Vidu 内置 |
| 上行内容 | PCM + 用户/助手文本 | 用户麦克风等 |
| RTC | **客户频道**（ARTC/TRTC/Agora/Volcengine RTC） | Vidu 下发 AliRTC |
| 与 qwen 关系 | 渲染插件 | 重复一套对话栈 |

qwen-audio-agent 的核心价值是 Realtime 运行时与后台 Agent 编排，因此 **只应接入组件版**。

计费参考（开放平台积分，与 www.vidu.com Creator 订阅无关）：

- 组件版：**1 积分/秒**（积分单价约 0.03125 元 → **约 0.031 元/秒**）
- 音色克隆等与组件版无关（完整版侧能力更多）

---

## 4. 总体架构

### 4.1 逻辑分层

与 [digital-human 架构设计](../../digital-human/docs/design.zh.md) 一致，仅将「Renderer」替换为 Vidu 外接直播 + WebSocket 喂数：

```text
┌─────────────┐     WebRTC/WSS      ┌──────────────────────────────────┐
│   WebUI     │ ◄──────────────────►│ qwen-audio-agent Gateway         │
│  mic + 视频  │                     │  Realtime / 工具 / 历史 / 编排器   │
└─────────────┘                     └───────────────┬──────────────────┘
                                                    │
                    助手 PCM + 转写                  │ DigitalHumanProvider
                    （presentation 内部事件）        ▼
                                    ┌──────────────────────────────────┐
                                    │ examples/vidu-digital-human      │
                                    │  ViduExternalLiveClient (WS)     │
                                    └───────────────┬──────────────────┘
                                                    │ 渲染完成
                                                    ▼
                                    ┌──────────────────────────────────┐
                                    │ 你的 RTC 房间 (ARTC/TRTC/Agora/Volcengine) │
                                    └───────────────┬──────────────────┘
                                                    │ 订阅数字人轨
                                                    ▼
                                    Media Worker → 客户端 PeerConnection 视频轨
```

### 4.2 一次用户提问到数字人回复（目标链路）

1. 用户经 WebRTC 上传麦克风；网关经 WSS 调用 Qwen Realtime。
2. 模型流式返回助手音频（及转写）；`realtime-presentation-runtime` 产生内部呈现事件。
3. **数字人模式**：编排器选择 `COMMITTED_AVATAR`，不向客户端直推 Realtime 原声（或仅作降级备份）。
4. Vidu 适配器经 WebSocket 持续发送：**二进制 PCM**、**用户转写 (type 9)**、**助手文本 (type 10)**。
5. Vidu 将数字人音视频推到创建会话时传入的 `rtc_info` 频道。
6. 网关 Media Worker 从该 RTC 订阅视频（及配对音频），再发布到与浏览器已有的 PeerConnection。
7. 客户端播放回执仍走现有 `playback.*` 语义；Provider 的 `turn.completed` 不等于用户已听完。

### 4.3 与 OpenAvatarChat 方案的关系

| 项目 | OpenAvatarChat / FlashHead | Vidu S 组件版 |
| --- | --- | --- |
| 部署 | 自建 GPU + Python 服务 | 云 API + 积分 |
| Provider 输入 | 流式助手 PCM | 同左 |
| 媒体回网关 | 私有 WSS 配对 AV | **RTC 订阅 + 桥接** |
| SPI | `DigitalHumanProvider` | **同一 SPI**，不同 Adapter |

两套 Renderer 可并存，由启动配置选择 Provider factory，不应在网关核心写死 Vidu。

---

## 5. Vidu 组件版协议要点

### 5.1 接入顺序

1. `POST https://{host}/live/s_avatar/component`\
   Body：`model`、`image_uri` 或 `avatar_id` + **`rtc_info`**（provider、channel_id、user_id、token 等）。旧账号可通过 `VIDU_CREATE_PATH` 覆盖路径。
2. 响应：`live.id`、`client_secret`（WebSocket 短期凭证，勿泄露到前端日志）。
3. `wss://{host}/live/v1/external-lives/{live_id}/stream`，服务端通过 `Authorization: vda_xxx` 认证；旧部署若必须使用 URL 短令牌，可设置 `VIDU_WS_CLIENT_SECRET=1`。\
   首帧 **`conn_init` (type 1)**，等待 **`conn_init_ack.success=true`**（`NOT_READY` 可重试 conn_init，勿重连 WS）。
4. 运行期：
   - **Binary**：裸 PCM16 LE，**24 kHz**，mono（建议 20ms/100ms 分帧）；
   - **type 9**：用户 ASR 最终/有效转写；
   - **type 10**：模型回复文本；
   - **type 7**：用户开口打断；
   - **type 5** 或关闭 WS：结束。

### 5.2 三样缺一不可

Vidu 文档明确：仅 PCM 或仅文本 **无法正确驱动** 数字人。网关必须把 Realtime 的 **音频 delta** 与 **用户/助手转写** 同步喂给 Vidu。

### 5.3 与 qwen 音频格式对齐

Web 端助手播放默认 **`OUTPUT_RATE = 24000`**（`web/src/realtime/useRealtimeVoice.js`），与 Vidu 组件版一致，**通常无需重采样**。若上游 Provider 输出其它采样率，须在适配器内做有状态重采样后再送 Vidu（SPI 契约建议 PCM16 / 24 kHz / mono）。

### 5.4 环境域名

| 环境 | HTTP | WebSocket |
| --- | --- | --- |
| 国内 | `https://api.vidu.cn` | `wss://api.vidu.cn` |
| 海外 | `https://api.vidu.com` | `wss://api.vidu.com` |

API Key 与环境一致；HTTP 认证头为 `Authorization: Token vda_xxx`，WebSocket 认证头使用原始 `vda_xxx`。

---

## 6. qwen 侧事件映射

实现参考：`examples/vidu-digital-human/providers/vidu/qwen-presentation-feed.mjs`。

| qwen / Realtime 侧（示意） | Vidu WebSocket | 说明 |
| --- | --- | --- |
| 用户转写完成 | type 9 `input_transcription` | 空 content 忽略 |
| 助手文本 delta / 最终 | type 10 `output_transcription` | 可按 delta 增量发送 |
| `response.output_audio.delta`（base64 PCM） | Binary 帧 | 与当前 `responseId` 对齐 |
| `input_audio_buffer.speech_started` | type 7 `audio_interrupted` | 打断数字人当前播报 |
| 响应结束 / 取消 | 停止送 PCM；必要时 hangup | 与编排器 `generation` 一致 |

**注意**：不能仅订阅对外 `transcript.delta` 且依赖「播放开始」门控，否则可能和 Provider 形成等待环；应在 [设计文档 §4.2](../../digital-human/docs/design.zh.md) 规定的内部呈现分支取文本。

---

## 7. 框架缺口与实施阶段

当前主分支已实现 `DigitalHumanOrchestrator`、Vidu Provider SPI、WebRTC `video_output` 协商、I420 视频轨发布、打断和 audio-only 降级。Vidu 厂商 RTC SDK 通过 `VIDU_RTC_BRIDGE_MODULE` 注入；仓库不替部署方选择或打包 ARTC/TRTC/Agora/Volcengine SDK。

### 阶段 M0 — 配置与 Vidu 连通性（已实现）

- [ ] 开放平台 API Key、充值积分\
- [ ] 形象：`image_uri` 或 `/live/v1/avatars` 上传得 `avatar_id`\
- [ ] RTC 应用与频道 token（与选定 provider 一致）\
- [x] 运行 `npm run preflight --prefix examples/vidu-digital-human`
- [x] 本地协议测试覆盖 `createExternalLive` + `openExternalLiveStream`、固定 PCM/文本和重试\
- [ ] 用真实凭据执行一次创建、握手、PCM/文本试推（部署验收，可能产生计费）\

**代码位置**：`providers/vidu/vidu-config.mjs`、`vidu-external-live-client.mjs`

### 阶段 M1 — 框架 SPI（已实现）

- [x] 启动注入 `digitalHuman`：Provider factory、persona 白名单\
- [x] 内部事件：由 `DigitalHumanOrchestrator` 从 Realtime response/audio/transcript 事件归一化\
- [x] 输出选择：Provider ready 时提交 paired avatar，未就绪或故障时保持/恢复普通音频\
- [x] 实现 `ViduDigitalHumanProvider`：封装外接直播生命周期 + WS 喂数\
- [x] 密钥仅服务端；浏览器只用网关 SDP/WebRTC\

**契约**：[provider-contract.zh.md](../../digital-human/docs/provider-contract.zh.md)

### 阶段 M2 — RTC 桥（框架已实现，厂商适配待注入）

Vidu 推流到 **你的** RTC；浏览器连 **qwen** WebRTC。必须二选一或组合：

| 策略 | 做法 | 优点 | 成本 |
| --- | --- | --- | --- |
| A. Worker 内订阅再转发 | Media Worker 用 SDK 订阅 Vidu 轨，编码后写入现有 PeerConnection | 用户只连网关 | 需维护双 RTC 栈 |
| B. 同源双订阅（不推荐生产） | 浏览器再订阅厂商 RTC | 实现快 | 暴露房间逻辑、密钥管理难 |

推荐 **策略 A**，与 design §3 媒体子进程边界一致。

- [ ] 每会话创建/绑定 RTC 房间与 token 生成服务（部署方职责）\
- [x] `rtc_info` 在 `createExternalLive` 时注入\
- [x] Media Source Adapter：RTC 帧 → I420/PCM → Worker 发布视频/音频轨\
- [x] 连接建立时 SDP 预置 video transceiver（不支持中途 renegotiate 增轨）

**代码参考**：`server/src/transport/webrtc/media-worker.mjs`、`media.mjs`

### 阶段 M3 — WebUI 与降级（已实现）

- [x] `/api/v1/webrtc/config` 扩展 `video_output`、`digital_human.available`\
- [x] SDP 创建可选 `avatarPersonaId`（服务端白名单）\
- [x] 状态事件：`digital_human.state`（ready / rendering / audio_only / closed）\
- [x] Provider 未就绪、首帧超时 → **audio_only** 降级\
- [x] 用户打断、内容安全、权限撤销 → 同步 cancel Realtime + Vidu + 清队列\

---

## 8. 配置说明（主项目统一配置）

Vidu 不是一个需要单独维护的服务端项目，而是主 Gateway 的可选 Renderer。配置统一写入
`qwenaudio config` 显示的 Gateway `config.env`，桌面版可在“设置 → 数字人”填写；
浏览器 WebUI 不保存也不接收 Vidu 密钥。示例目录的 `.env.example` 仅用于开发者快速试跑。

关键变量如下：

| 变量 | 含义 |
| --- | --- |
| `VIDU_API_KEY` | 开放平台 Key，仅服务端 |
| `VIDU_API_HOST` | `api.vidu.cn` 或 `api.vidu.com` |
| `VIDU_AVATAR_IMAGE_URI` / `VIDU_AVATAR_ID` | 形象二选一 |
| `VIDU_PERSONA_ID` / `VIDU_PERSONA_LABEL` | WebRTC persona 选择器中的稳定 ID 与显示名 |
| `VIDU_RTC_PROVIDER` | `artc` / `trtc` / `agora` / `volcengine` |
| `VIDU_RTC_CHANNEL_ID` / `USER_ID` / `TOKEN` | Vidu 入会凭证 |
| `VIDU_RTC_BRIDGE_MODULE` | 服务端 RTC SDK 桥，导出 `openViduRtcBridge()`；未配置时保持纯语音 |
| `DASHSCOPE_API_KEY` | qwen Realtime（与其它示例相同） |

配置完成后直接启动主项目 Gateway；配置桥接模块后，WebRTC 示例中的 persona 选择器会启用数字人：

```bash
npm run example:webrtc:install   # 仓库根目录，若未装 WebRTC 扩展
# 将上表变量写入 qwenaudio config 展示的 config.env
npm start
```

仍可用 `npm run start --prefix examples/vidu-digital-human` 作为开发辅助入口；它最终调用
同一个主 Gateway 装配器，不会启动第二套对话服务。

---

## 9. 安全与运维

- **API Key** 和 `client_secret` 不得下发浏览器；默认仅用服务端 WebSocket Authorization，避免把短令牌放进 URL 日志。
- 日志脱敏：不记录 PCM 正文、完整 token、`client_secret`。
- 并发：Vidu 开放平台默认约 5 路并发；超出按定价扩容。
- 故障：关注 WS `force_hangup (type 6)`、积分不足、409 已有活跃连接；`live.trace_id` 用于工单。
- 内容审核：`moderation` 字段按 Vidu 要求配置（外接直播创建 body）。

---

## 10. 验收清单（建议）

| # | 项 | 通过标准 |
| --- | --- | --- |
| 1 | 纯语音回归 | 未开数字人时与现网 WebRTC 行为一致 |
| 2 | Vidu 会话 | 外接直播创建成功，`conn_init_ack` 成功 |
| 3 | 三路数据 | 每轮同时具备 PCM + type 9 + type 10 |
| 4 | 口型 | 助手说话时数字人嘴型与音频明显相关 |
| 5 | 打断 | 用户开口后数字人停止当前句，与 Realtime 打断一致 |
| 6 | 一路声音 | 数字人模式下客户端不重复播放 Realtime 原声 |
| 7 | 降级 | Vidu 超时/失败时进入 audio_only 或明确 error，不 silent fail |
| 8 | 计费 | `GET /live/v1/lives/{id}` 中 `credits_cost` 与预期时长一致 |

---

## 11. 仓库内代码索引

```text
examples/vidu-digital-human/
  docs/integration-guide.zh.md     ← 本文
  providers/vidu/
    vidu-config.mjs
    vidu-external-live-client.mjs
    vidu-digital-human-provider.mjs
    vidu-rtc-bridge.mjs
    qwen-presentation-feed.mjs
  bootstrap/start.mjs
  bootstrap/preflight.mjs
  test/vidu-config.test.mjs
```

相关设计（OpenAvatarChat Renderer 仍待实现；公共契约已落地）：

```text
examples/digital-human/docs/
  design.zh.md
  provider-contract.zh.md
  implementation-plan.zh.md
```

---

## 12. 外部参考

- [Vidu 组件版（外接直播）](https://platform.vidu.cn/docs/vidu-s1-1)
- [Vidu Stream 文档入口](https://platform.vidu.com/vidu-stream/doc)
- [Vidu 开放平台定价](https://platform.vidu.cn/docs/pricing)
- [Vidu S2 产品介绍（官网）](https://www.vidu.com/zh/vidu-stream)

---

## 13. 修订记录

| 日期 | 说明 |
| --- | --- |
| 2026-10-03 | 初版：方向、架构、协议映射、分阶段实施与验收 |
