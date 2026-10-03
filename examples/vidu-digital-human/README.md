# Vidu S digital human × qwen-audio-agent

See [README_ZH.md](README_ZH.md) for the full integration guide (Chinese).

This adds a **Vidu S Avatar Component** adapter (`external-lives` + WebSocket PCM) aligned with qwen’s 24 kHz assistant audio. The adapter is loaded by the main Gateway from its shared `config.env`; it does not start a second conversation server. A vendor RTC SDK adapter must be supplied through `VIDU_RTC_BRIDGE_MODULE`; no ARTC, TRTC, Agora, or Volcengine native SDK is bundled.

See the [integration guide](docs/integration-guide.md) and [Chinese guide](docs/integration-guide.zh.md).
