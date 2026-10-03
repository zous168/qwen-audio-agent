# 数字人示例

[English](README.md) | [中文](README_ZH.md)

**状态：OpenAvatarChat/FlashHead 路线仍是设计方案；Vidu S 组件版路线已提供可运行的网关接入骨架。** 当前目录不捆绑 GPU Renderer 或厂商 SDK。

基于 GitHub `main` 的 WebRTC PR #465，基线提交 `9ad6348f`，设计日期 2026-09-18。

## 数字人演示

**自然对话，声形相随。** 语音驱动数字人的口型与表情，展示实时对话的交互效果。

https://github.com/user-attachments/assets/5301ef5e-b674-4561-93bb-e0c7544cf696

## 目标

- 客户端只连接 qwen-audio-agent 网关。
- Realtime 模型继续负责理解、对话和回复语音，模型侧仍用 WSS。
- `DigitalHumanProvider` 只消费助手回复音频，文本是可选增强，不承担 ASR、LLM、TTS 或 S2S。
- 首版接入方案复用 OpenAvatarChat 的 FlashHead Avatar 组件，在独立 Python GPU 服务中运行 SoulX-FlashHead Lite。
- 以 LiveAvatar Avatar Only / LITE 校验抽象，不要求首版实现 LiveAvatar 或引入其 SDK。
- 专用依赖、适配器、安装脚本及部署文件都放在本 example，不加入主框架默认依赖。

## 云厂商替代：Vidu S 组件版

若不自建 GPU + OpenAvatarChat，可用 [Vidu S 外接直播（组件版）](../vidu-digital-human/docs/integration-guide.zh.md)：Qwen Realtime 仍负责对话，Vidu 只消费助手 PCM + 双端转写并推到你的 RTC。适配器应实现同一套 `DigitalHumanProvider` 契约，厂商逻辑留在 `examples/vidu-digital-human/`。

## 阅读顺序

1. [架构设计](docs/design.zh.md)：职责、链路、框架扩展点、会话及部署边界。
2. [Provider 契约](docs/provider-contract.zh.md)：输入输出、生命周期、媒体接口，以及两个具体 Provider 的映射。
3. [开发与验收计划](docs/implementation-plan.zh.md)：OpenAvatarChat 接入步骤、依赖隔离、里程碑及测试清单。

这三份文档是本轮评审依据。目录中其他设计和 ADR 为历史草案，不应按其中的浏览器直连 Renderer 路线实施。

## 实施范围

框架需要补充轻量的呈现接口和视频下行能力；“不增加框架依赖”不代表“完全不改框架”。实际厂商实现留在 example，通过启动时注入接入。

先在 Mac 上完成真实 WebRTC 音视频通路的 Mock，再连接 Linux/NVIDIA 上的 OpenAvatarChat Renderer。Mock 不是模型推理，也不是浏览器本地动嘴动画。

OpenAvatarChat Renderer 的安装命令仍待实现；Vidu 路线的配置和启动命令见上面的专用 example 及[接入说明](../vidu-digital-human/docs/integration-guide.zh.md)。
