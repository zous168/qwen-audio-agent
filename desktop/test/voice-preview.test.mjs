import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { previewRealtimeVoice } from '../src/voice-preview.mjs'

const options = {
  model: 'qwen-audio-3.0-realtime-plus', voice: 'longanlingxin',
  endpoint: 'wss://example.test/realtime', credential: 'test-key',
}

test('voice preview uses a separate realtime session and returns PCM audio', async () => {
  let socket
  class FakeSocket extends EventEmitter {
    constructor(url, config) {
      super()
      socket = this
      assert.match(url, /model=qwen-audio-3\.0-realtime-plus/)
      assert.equal(config.headers.Authorization, 'Bearer test-key')
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.created' })))
    }
    send(raw) {
      const event = JSON.parse(raw)
      if (event.type === 'session.update') {
        assert.equal(event.session.voice, 'longanlingxin')
        queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session.updated' })))
      } else if (event.type === 'conversation.item.create') {
        assert.equal(event.item.role, 'user')
        queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'conversation.item.created' })))
      } else if (event.type === 'response.create') {
        assert.deepEqual(event.response.modalities, ['text', 'audio'])
        queueMicrotask(() => {
          this.emit('message', JSON.stringify({ type: 'conversation.item.created' }))
          this.emit('message', JSON.stringify({ type: 'response.audio.delta', delta: Buffer.from([1, 2, 3, 4]).toString('base64') }))
          this.emit('message', JSON.stringify({ type: 'response.done', response: { status: 'completed' } }))
        })
      } else {
        assert.fail(`Unexpected event: ${event.type}`)
      }
    }
    close() { this.closed = true }
  }
  const result = await previewRealtimeVoice(options, { WebSocketClass: FakeSocket })
  assert.equal(result.audio, Buffer.from([1, 2, 3, 4]).toString('base64'))
  assert.equal(result.sampleRate, 24_000)
  assert.equal(socket.closed, true)
})

test('voice preview requires a key and a secure or loopback endpoint', async () => {
  await assert.rejects(previewRealtimeVoice({ ...options, credential: '' }), /API Key/)
  await assert.rejects(previewRealtimeVoice({ ...options, endpoint: 'ws://remote.test/realtime' }), /WebSocket/)
  await assert.rejects(previewRealtimeVoice({
    ...options, model: 'qwen3.8-omni-flash-realtime', voice: 'Tina',
    endpoint: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime',
  }), /业务空间专属/)
})
