import { BrowserWebRtcConnection } from './webrtc-browser.mjs'

// Socket contract for GatewayClient: one GCP session, with RTP presentation.
// The SDK continues to own authentication, capabilities, recovery and tools.
export class GatewayWebRtcSocket extends EventTarget {
  constructor({ sessionId, fetch, avatarPersonaId, onVideoStream, onError, Connection = BrowserWebRtcConnection }) {
    super()
    this.readyState = 0
    this.connection = new Connection({
      sessionId, fetch, avatarPersonaId, onVideoStream, protocol: 'gateway',
      onOpen: () => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this.dispatchEvent(new Event('open'))
      },
      onEvent: event => {
        if (event.type.startsWith('qwaudio.')) return
        this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(event) }))
      },
      onError: error => {
        onError?.(error)
        this.dispatchEvent(new Event('error'))
      },
      onClose: ({ code, reason }) => {
        if (this.readyState === 3) return
        this.readyState = 3
        const event = new Event('close')
        Object.assign(event, { code, reason })
        this.dispatchEvent(event)
      },
    })
    // GatewayClient attaches handlers synchronously after construction.
    queueMicrotask(() => { if (this.readyState === 0) void this.connection.connect() })
  }
  get bufferedAmount() { return (this.connection.channel?.bufferedAmount || 0) + (this.connection.outgoingBytes || 0) }
  send(raw) {
    if (this.readyState !== 1 || !this.connection.send(JSON.parse(raw))) throw new Error('WebRTC socket is not open')
  }
  close() { return this.connection.close() }
}
