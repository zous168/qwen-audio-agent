import test from 'node:test'
import assert from 'node:assert/strict'
import { GatewayWebRtcSocket } from '../shared/gateway/webrtc-socket.mjs'
import { BrowserWebRtcConnection } from '../shared/gateway/webrtc-browser.mjs'
import { WebRtcMessageReader, GATEWAY_WEBRTC_MESSAGE_BYTES } from '../shared/gateway/webrtc-message.mjs'

test('RTC socket exposes original GCP events and ownership close codes to the shared SDK', async () => {
  class Connection {
    constructor(options) { this.options = options }
    connect() { this.options.onOpen() }
    send(event) { this.sent = event; return true }
    close() { this.options.onClose({ code: 4001, reason: 'occupied' }) }
  }
  const socket = new GatewayWebRtcSocket({ sessionId: 'same-session', Connection })
  const events = []
  let close
  socket.addEventListener('message', event => events.push(JSON.parse(event.data)))
  socket.addEventListener('close', event => { close = event })
  await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
  socket.send(JSON.stringify({ type: 'session.hello', event_id: 'hello-1' }))
  assert.equal(socket.connection.sent.type, 'session.hello')
  socket.connection.options.onEvent({ type: 'task.list.result', request_event_id: 'task-1', tasks: [] })
  socket.connection.options.onEvent({ type: 'qwaudio.output.started' })
  assert.deepEqual(events, [{ type: 'task.list.result', request_event_id: 'task-1', tasks: [] }])
  await socket.close()
  assert.equal(close.code, 4001)
  assert.equal(socket.readyState, 3)
})

test('shared RTC controls carry attachments larger than the diagnostic-page limit', () => {
  const frames = []
  const connection = Object.assign(Object.create(BrowserWebRtcConnection.prototype), {
    protocol: 'gateway', closed: false, outgoing: [], outgoingBytes: 0,
    channel: { readyState: 'open', bufferedAmount: 0, send: frame => frames.push(frame) },
    fail: error => { throw error },
  })
  const event = { type: 'input.message', parts: [{ type: 'text', text: 'x'.repeat(1024 * 1024) }] }
  assert.equal(connection.send(event), true)
  const reader = new WebRtcMessageReader({ maxBytes: GATEWAY_WEBRTC_MESSAGE_BYTES })
  let result
  for (const frame of frames) result = reader.read(frame) || result
  assert.equal(JSON.parse(result).parts[0].text.length, 1024 * 1024)
  assert.equal(connection.outgoingBytes, 0)
})

test('a silent or muted drained RTC response sends cancellation, never fake playback start', () => {
  const receipts = []
  const connection = Object.assign(Object.create(BrowserWebRtcConnection.prototype), {
    analyser: null,
    outputs: new Map([['silent', { started: false, drained: performance.now() - 2000, quiet: 0 }]]),
    receipt: (type, id) => receipts.push({ type, id }), onPlayback() {},
  })
  connection.measurePlayback()
  assert.deepEqual(receipts, [{ type: 'cancelled', id: 'silent' }])
  assert.equal(connection.outputs.size, 0)
})
