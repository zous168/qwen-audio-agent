import test from 'node:test'
import assert from 'node:assert/strict'
import { loadViduConfig } from '../providers/vidu/vidu-config.mjs'
import { decodeAssistantAudioBase64 } from '../providers/vidu/vidu-external-live-client.mjs'
import { createExternalLive, openExternalLiveStream } from '../providers/vidu/vidu-external-live-client.mjs'
import { ViduDigitalHumanProvider, createViduDigitalHuman } from '../providers/vidu/vidu-digital-human-provider.mjs'

class FakeWebSocket {
  static instances = []
  static nextNotReady = 0

  constructor(url, options) {
    this.url = url
    this.options = options
    this.listeners = new Map()
    this.sent = []
    this.readyState = 1
    this.retryAckOnSend = false
    FakeWebSocket.instances.push(this)
    queueMicrotask(() => {
      this.emit('open')
      queueMicrotask(() => this.emit('message', JSON.stringify({
        type: 2,
        payload: { conn_init_ack: FakeWebSocket.nextNotReady-- > 0
          ? (this.retryAckOnSend = true, { success: false, error_code: 'NOT_READY' })
          : { success: true } },
      })))
    })
  }

  on(name, handler) { this.listeners.set(name, handler); return this }
  emit(name, value) { this.listeners.get(name)?.(value) }
  send(value) {
    this.sent.push(value)
    const message = typeof value === 'string' ? JSON.parse(value) : null
    if (message?.type === 1 && this.sent.length > 1) {
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 2, payload: { conn_init_ack: { success: true } } })))
    }
  }
  close() { this.readyState = 3; this.emit('close') }
}

test('loadViduConfig requires API key and RTC fields', () => {
  assert.throws(() => loadViduConfig({}), /VIDU_API_KEY/)
  assert.throws(
    () => loadViduConfig({
      VIDU_API_KEY: 'vda_test',
      VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    }),
    /VIDU_RTC/,
  )
})

test('loadViduConfig builds https/wss bases', () => {
  const config = loadViduConfig({
    VIDU_API_KEY: 'vda_test',
    VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    VIDU_RTC_PROVIDER: 'agora',
    VIDU_RTC_CHANNEL_ID: 'room',
    VIDU_RTC_USER_ID: 'u1',
    VIDU_RTC_TOKEN: 'tok',
  })
  assert.equal(config.httpBase, 'https://api.vidu.cn')
  assert.equal(config.wsBase, 'wss://api.vidu.cn')
  assert.equal(config.rtcInfo.provider, 'agora')
})

test('loadViduConfig rejects unsupported RTC providers before making a request', () => {
  assert.throws(() => loadViduConfig({
    VIDU_API_KEY: 'vda_test',
    VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    VIDU_RTC_PROVIDER: 'unknown',
    VIDU_RTC_CHANNEL_ID: 'room',
    VIDU_RTC_USER_ID: 'u1',
    VIDU_RTC_TOKEN: 'tok',
  }), /VIDU_RTC_PROVIDER/)
})

test('decodeAssistantAudioBase64 accepts PCM16 payloads', () => {
  const pcm = Buffer.from([0, 0, 255, 127])
  const encoded = pcm.toString('base64')
  assert.deepEqual(decodeAssistantAudioBase64(encoded), pcm)
})

test('createExternalLive uses the current component endpoint and request shape', async () => {
  let request
  const result = await createExternalLive(loadViduConfig({
    VIDU_API_KEY: 'vda_test',
    VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    VIDU_RTC_PROVIDER: 'artc',
    VIDU_RTC_CHANNEL_ID: 'room',
    VIDU_RTC_USER_ID: 'u1',
    VIDU_RTC_TOKEN: 'tok',
  }), {
    fetchImpl: async (url, init) => {
      request = { url, init }
      return { ok: true, status: 200, json: async () => ({ live: { id: 'live-1', trace_id: 'trace-1' }, client_secret: 'secret-1' }) }
    },
  })
  assert.equal(request.url, 'https://api.vidu.cn/live/s_avatar/component')
  assert.equal(JSON.parse(request.init.body).model, 'vidu-s2')
  assert.deepEqual(result, { liveId: 'live-1', clientSecret: 'secret-1', live: { id: 'live-1', trace_id: 'trace-1' }, traceId: 'trace-1' })
})

test('Vidu stream sends handshake, framed PCM, text and interrupt signals', async () => {
  const config = loadViduConfig({
    VIDU_API_KEY: 'vda_test',
    VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    VIDU_RTC_PROVIDER: 'artc',
    VIDU_RTC_CHANNEL_ID: 'room',
    VIDU_RTC_USER_ID: 'u1',
    VIDU_RTC_TOKEN: 'tok',
  })
  const stream = await openExternalLiveStream(config, { liveId: 'live-1', clientSecret: 'secret-1' }, { WebSocket: FakeWebSocket })
  const socket = FakeWebSocket.instances.at(-1)
  assert.match(socket.url, /external-lives\/live-1\/stream/)
  assert.doesNotMatch(socket.url, /client_secret/)
  assert.equal(socket.options.headers.Authorization, 'vda_test')
  assert.equal(JSON.parse(socket.sent[0]).type, 1)
  stream.sendPcm(Buffer.alloc(960))
  stream.sendInputTranscription('你好', 'in-1')
  stream.sendOutputTranscription('你好，我是助手', 'out-1')
  stream.interrupt()
  const types = socket.sent.slice(1).filter(value => typeof value === 'string').map(value => JSON.parse(value).type)
  assert.deepEqual(types, [9, 10, 7])
  assert.equal(Buffer.isBuffer(socket.sent[1]), true)
  stream.hangup()
})

test('Vidu stream retries NOT_READY on the same WebSocket', async () => {
  FakeWebSocket.nextNotReady = 1
  const config = loadViduConfig({
    VIDU_API_KEY: 'vda_test', VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    VIDU_RTC_PROVIDER: 'artc', VIDU_RTC_CHANNEL_ID: 'room', VIDU_RTC_USER_ID: 'u1', VIDU_RTC_TOKEN: 'tok',
  })
  await openExternalLiveStream(config, { liveId: 'live-retry', clientSecret: 'secret-1' }, { WebSocket: FakeWebSocket })
  const socket = FakeWebSocket.instances.at(-1)
  assert.deepEqual(socket.sent.map(value => typeof value === 'string' ? JSON.parse(value).type : 'pcm'), [1, 1])
})

test('Vidu provider maps streaming audio/text into the component and media callbacks', async () => {
  const config = loadViduConfig({
    VIDU_API_KEY: 'vda_test',
    VIDU_AVATAR_IMAGE_URI: 'https://example.com/a.jpg',
    VIDU_RTC_PROVIDER: 'artc',
    VIDU_RTC_CHANNEL_ID: 'room',
    VIDU_RTC_USER_ID: 'u1',
    VIDU_RTC_TOKEN: 'tok',
  })
  const media = []
  let emitAudio
  const provider = new ViduDigitalHumanProvider({
    config,
    mediaBridgeFactory: async options => {
      emitAudio = options.onAudio
      return { close() {}, async waitForDrain() {} }
    },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ live: { id: 'live-2' }, client_secret: 'secret-2' }) }),
    webSocket: FakeWebSocket,
  })
  const session = await provider.openSession({})
  session.on('media', event => media.push(event))
  await session.startTurn({ avatarSessionId: 'live-2', responseId: 'r1', generation: 1 })
  emitAudio({ data: Buffer.alloc(4), sampleRate: 24000 })
  await session.appendAudio({ avatarSessionId: 'live-2', responseId: 'r1', generation: 1, sequence: 1, sampleOffset: 0, data: Buffer.alloc(1920) })
  await session.appendText({ avatarSessionId: 'live-2', responseId: 'r1', generation: 1, sequence: 2, delta: '你好' })
  await session.finishTurn({ avatarSessionId: 'live-2', responseId: 'r1', generation: 1, lastAudioSequence: 1, totalSamples: 960 })
  assert.equal(media.length, 1)
  assert.equal(media[0].type, 'media.audio')
  assert.equal(createViduDigitalHuman({ config, mediaBridgeFactory: async () => ({ close() {} }) }).available, true)
  await session.close()
})
