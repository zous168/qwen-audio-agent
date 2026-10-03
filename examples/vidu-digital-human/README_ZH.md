# Vidu S 数字人 × qwen-audio-agent

[English](README.md)

**完整技术说明：[docs/integration-guide.zh.md](docs/integration-guide.zh.md)**（架构、协议映射、分阶段实施、验收清单）

在 **不替换 Qwen Realtime 大脑** 的前提下，用 [Vidu S 组件版（外接直播）](https://platform.vidu.cn/docs/vidu-s1-1) 做口型与形象渲染。

## 为什么选组件版

| 能力 | qwen-audio-agent 已有 | Vidu S 组件版 |
| --- | --- | --- |
| ASR / LLM / TTS / 工具 / 记忆 | Realtime 网关 | 不用 |
| 用户麦克风 → 模型 | WSS + WebRTC 上行 | 不用 |
| 助手回复音频 | `response.output_audio.delta`（24kHz PCM） | **WebSocket 二进制上行** |
| 用户 / 助手文本 | 转写与字幕事件 | **type 9 / 10 必填** |
| 数字人画面 | 暂无 | Vidu 推到 **你的 RTC 频道** |

不要用 Vidu **实时完整版**（Vidu 自带 ASR/LLM/TTS），会和现有 Realtime 重复一套对话栈。

## 当前仓库状态

- 主项目 Gateway 已提供 `DigitalHumanOrchestrator`、WebRTC `video_output` 协商、视频轨发布和打断/降级路径。
- 本目录提供 Vidu HTTP/WS Provider；厂商 RTC SDK 仍通过 `VIDU_RTC_BRIDGE_MODULE` 注入，仓库不捆绑 ARTC/TRTC/Agora/Volcengine 原生包。
- 主 Gateway 会从统一的 `config.env` 自动装配该适配器；未配置桥接模块时仍提供纯语音。此目录只是适配器代码与开发辅助入口，不是第二个产品或第二套 Gateway。

## 目录

```text
examples/vidu-digital-human/
  providers/vidu/
    vidu-config.mjs              # 环境变量 → API 配置
    vidu-external-live-client.mjs # 创建外接直播 + WebSocket 喂 PCM/文本
    qwen-presentation-feed.mjs     # Realtime 事件 → Vidu 信号（兼容层）
    vidu-digital-human-provider.mjs # Provider + 会话生命周期
    vidu-rtc-bridge.mjs             # 外部 RTC SDK 加载契约
  bootstrap/start.mjs
  test/
```

## 配置

```bash
# 推荐：运行 qwenaudio config，在主项目 config.env 中填写
# DASHSCOPE_API_KEY、VIDU_API_KEY、形象图、RTC 频道凭证和桥接模块路径
# 开发试跑也可复制本目录 .env，再执行：
npm run preflight --prefix examples/vidu-digital-human
```

组件版必须准备 **阿里 ARTC / 腾讯 TRTC / 声网 Agora / 火山引擎 Volcengine RTC** 之一：Vidu 用你传入的 `rtc_info` 入会推数字人流；浏览器仍通过 qwen 的 WebRTC 连网关，**中间需要媒体桥**（见下节）。

## 接入步骤（推荐顺序）

### M1 — 验证 Vidu 凭据（本目录已支持）

在服务端脚本中：

1. `createExternalLive(config)` → `live_id` + `client_secret`
2. `openExternalLiveStream(config, session)` → 等待 `conn_init_ack`
3. 每轮回复：`sendInputTranscription` / `sendOutputTranscription` + `sendPcm`（PCM16 / 24kHz / mono）

音频格式与 Web 端 `OUTPUT_RATE = 24000` 一致，一般 **无需重采样**。

### M2 — RTC 桥（与 qwen WebRTC 对齐）

网关媒体子进程 today 使用自有 WebRTC 栈（见 `server/src/transport/webrtc/`）。Vidu 组件版要求 **独立 RTC 房间 token**。典型做法：

1. 为每个语音会话在 ARTC/TRTC/Agora/Volcengine RTC 创建 **仅用于数字人下行** 的频道；
2. 把 token 填入 `VIDU_RTC_*`，创建外接直播；
3. 在 **Media Worker** 内订阅 Vidu 推来的数字人轨，再混流或二次发布到客户端 PeerConnection（与 [digital-human 设计](../digital-human/docs/design.zh.md) §3 一致）。

网关已经通过 `DigitalHumanOrchestrator` 和 `MediaBinding` 接通这条生命周期；仍需实现所选厂商的 `openViduRtcBridge()`，将 Vidu 房间的音视频帧回调给网关。

### M3 — 挂接 Qwen 事件

网关现在在 `realtime-presentation-runtime` 之后处理这些事件，当用户选择数字人模式时：

- 把 `response.output_audio.delta` 复制一份到 `qwen-presentation-feed`（并 **抑制** 客户端重复播放原声，见设计文档「一路声音」）；
- 用户开口 → `input_audio_buffer.speech_started` → `interrupt()`；
- 用户最终转写 → `sendInputTranscription`；
- 助手文本增量/最终 → `sendOutputTranscription`。

参考映射见 `providers/vidu/qwen-presentation-feed.mjs`；实际会话由 `vidu-digital-human-provider.mjs` 接管。

## 计费（Vidu 侧）

- 组件版：**1 积分/秒**（约 0.03125 元/积分 → **≈0.031 元/秒**）
- 需开放平台充值，与 www.vidu.com Creator 订阅无关

## 参考

- **[接入技术说明（主文档）](docs/integration-guide.zh.md)**
- [Vidu 组件版协议](https://platform.vidu.cn/docs/vidu-s1-1)
- [Vidu Stream 总览](https://platform.vidu.com/vidu-stream/doc)
- [qwen 数字人架构（OpenAvatarChat 方案）](../digital-human/docs/design.zh.md) — SPI 与 Vidu 适配器同构
