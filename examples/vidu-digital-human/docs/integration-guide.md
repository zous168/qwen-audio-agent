# Vidu S real-time digital human integration

This example keeps Qwen Realtime responsible for conversation, tools, history,
interrupts, and safety. Vidu S Avatar Component Edition renders the avatar and
publishes its paired audio/video. The gateway owns credentials and chooses the
audio-only or paired-AV presentation for each WebRTC session.

## Current status

The repository contains the provider orchestrator, Vidu HTTP/WebSocket client,
WebRTC video output negotiation, I420 video publishing, interruption, content
safety cleanup, and audio-only fallback. A vendor RTC SDK bridge is still
deployment-specific and is loaded with `VIDU_RTC_BRIDGE_MODULE`; ARTC, TRTC,
Agora, and Volcengine native packages are not bundled.

The Vidu API accepts `artc`, `trtc`, `agora`, and `volcengine` as RTC providers.

The main application at `/` now provides the avatar selector, video, interruption
and fallback in both WebUI and the desktop conversation panel. The desktop orb
can display the same video stream. The WebRTC example remains a diagnostic tool.
GCP over the DataChannel preserves the same session, tasks, permissions, history,
desktop tools and presence. Audio-only mode uses WSS; avatar mode sends rendered
audio/video over RTP while retaining the shared application's input capture.

Before the first rendered audio, failures replay buffered original speech. After
rendered playback starts, a failure stops that response and subsequent turns use
original audio. A failed RTC connection reconnects over WSS. Vendor credentials
remain server-side; `/api/digital-human` exposes only availability and persona
IDs/labels behind Gateway authentication.

Chromium integration tests cover both application surfaces with synthetic avatar
media, including actual RTP decoding, transcripts, switching and media-process
failure. Live Vidu lip sync, latency and billing still require a vendor RTC bridge
and real credentials. Local server settings can be edited in desktop Settings;
the WebUI does not expose a remote server-secret editor.

The implementation review fixed stale callbacks affecting replacement turns,
original speech lost during early fallback, video frames cancelling the first
audio deadline, and invalid Windows RTC bit-depth metadata closing connections.
All 56 focused regression tests pass, including three consecutive Audio/Omni
connections and actual RTP decoding in both shared application surfaces. The
build, ESLint and diff checks pass. Desktop panel automation uses Chromium;
native Electron permissions and live vendor media still need integration checks.

To preview without cloud credentials in PowerShell, set
`$env:QWEN_AUDIO_ALLOW_UNCONFIGURED = '1'` and run `npm start --workspace desktop`.
Desktop starts the local Gateway and opens Settings; Web uses that Gateway's `/`.
Stop any separately launched Gateway first so Desktop can manage configuration
restarts. This flag enables UI preview only; it does not enable cloud sessions.

## Responsibility split

| Concern | Owner |
| --- | --- |
| ASR, LLM, TTS, tools, memory, safety, interruption | Qwen Realtime and qwen-audio-agent |
| Avatar appearance, lip sync, rendered media | Vidu S component |
| Browser microphone and avatar video track | Gateway WebRTC |
| API keys, Vidu session, RTC credentials | Gateway server |

The component edition is the correct fit because the complete Vidu edition would
introduce a second ASR/LLM/TTS stack.

## Data flow

1. The browser sends microphone audio to the gateway WebRTC session.
2. Qwen Realtime emits assistant PCM and transcript events.
3. `DigitalHumanOrchestrator` maps user transcription to type 9, assistant
   transcript to type 10, assistant PCM to binary PCM, and speech start to type 7.
4. Vidu renders into the RTC channel supplied in `rtc_info`.
5. The injected RTC bridge calls `onAudio` and `onVideo`; the gateway publishes
   those frames on the already-negotiated browser audio/video tracks.
6. When the paired provider is ready, the gateway suppresses the original Qwen
   audio delta to prevent double playback. Playback receipts remain gateway
   events and do not decide whether Vidu may finish its render drain.

## Vidu protocol

The current component endpoint is `POST /live/s_avatar/component` with `model`,
`image_uri` or `avatar_id`, and `rtc_info`. Older deployments can override the
path with `VIDU_CREATE_PATH`. The stream is
`/live/v1/external-lives/{live_id}/stream`; the server uses a raw `vda_...`
Authorization header for WebSocket authentication. `VIDU_WS_CLIENT_SECRET=1`
enables the legacy query-string credential when required by an older account.

The stream starts with type 1 `conn_init` and waits for type 2
`conn_init_ack.success`. Binary frames are PCM16 little-endian, mono, 24 kHz.
Type 9 carries user transcription, type 10 carries assistant transcription,
type 7 interrupts the current render, and type 5 hangs up.

## RTC bridge contract

`VIDU_RTC_BRIDGE_MODULE` must export:

```js
export async function openViduRtcBridge({
  rtcInfo, live, liveId, signal, onAudio, onVideo,
}) {
  // Join the Vidu RTC channel and subscribe to its rendered tracks.
  return {
    close() {},
  }
}
```

`onAudio` receives a `Buffer` or `{ data: Buffer, sampleRate: 24000 }`.
`onVideo` receives `{ data, width, height, format: 'I420', rotation? }`.
The bridge must stop callbacks after `close()`. This boundary keeps vendor SDKs
out of the gateway and makes the rest of the integration testable without a
live account.

## Configuration and startup

Vidu is an optional renderer inside the main Gateway, not a second server. Put
`DASHSCOPE_API_KEY`, `VIDU_API_KEY`, an avatar (`VIDU_AVATAR_IMAGE_URI` or
`VIDU_AVATAR_ID`), optional persona metadata (`VIDU_PERSONA_ID` and
`VIDU_PERSONA_LABEL`), the selected RTC fields, and `VIDU_RTC_BRIDGE_MODULE` in the
Gateway `config.env` shown by `qwenaudio config`. The desktop Settings page can
write these server-side values; browser WebUI never receives the keys. Then run:

```bash
npm run preflight --prefix examples/vidu-digital-human
npm start
```

The example `npm run start --prefix examples/vidu-digital-human` remains a
development convenience and delegates to the same main Gateway assembler.

The browser example reads `/api/v1/webrtc/config`, validates the persona on the
server, and adds a recvonly video transceiver before posting the SDP offer.

## Acceptance checks

- Audio-only WebRTC behavior is unchanged when no persona is selected.
- Vidu create and `conn_init_ack` succeed.
- Each turn sends PCM, type 9, and type 10 where content is available.
- The paired browser output has one audio source and one video track.
- Speech start, explicit interrupt, content safety, mute, and transport loss
  clear Vidu and gateway media queues together.
- Vidu startup or first-media timeout produces `digital_human.state` with
  `audio_only`; it never silently suppresses the Qwen audio.
- API keys and short-lived client secrets never reach browser configuration or
  normal logs.

See the [Chinese integration guide](integration-guide.zh.md),
[`README_ZH.md`](../README_ZH.md), and the official [Vidu component
documentation](https://platform.vidu.com/vidu-stream/doc/s2-avatar/component/parameters).
