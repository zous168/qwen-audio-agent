import test from 'node:test'
import assert from 'node:assert/strict'
import { isReliableOrderedChannel, NativeWebRtcMedia } from '../src/transport/webrtc/media.mjs'
import { WebRtcConnection } from '../src/transport/webrtc/protocol.mjs'
import { FakeMedia, testProvider } from './fixtures/webrtc-gateway.mjs'
import { decodePcm } from '../src/transport/webrtc/pcm.mjs'

test('native sink accepts PCM16 despite invalid bit-depth metadata and rejects other buffers', () => {
  const received = []
  const failures = []
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    rtc: { nonstandard: { RTCAudioSink: class {} } },
    sinks: [], audioTracks: 0, inputSampleRate: 16000,
    onAudio: audio => received.push(decodePcm(audio)), fail: message => failures.push(message),
  })
  media.receiveTrack({ kind: 'audio' })
  const samples = Int16Array.from([100, -100, 32767, -32768])
  const input = { samples, sampleRate: 16000, bitsPerSample: 5.2592956723e-313, channelCount: 1, numberOfFrames: 4 }
  media.sinks[0].ondata(input)
  assert.deepEqual(received, [samples])
  assert.deepEqual(failures, [])
  media.sinks[0].ondata({ ...input, samples: new Float32Array(4), bitsPerSample: 16 })
  media.sinks[0].ondata({ ...input, numberOfFrames: 5 })
  assert.equal(received.length, 1)
  assert.match(failures[0], /PCM16 input required/)
  assert.match(failures[1], /invalid PCM frame length/)
})

test('duplex mode uses the incoming channel without allocating a second SCTP stream', () => {
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    duplexControl: true,
    pc: { createDataChannel() { assert.fail('second channel must not be allocated') } },
  })
  media.openEventsChannel()
  assert.equal(media.events, undefined)
})

test('reliable channels accept browser null and native uint16 sentinels', () => {
  for (const unlimited of [null, undefined, 65535]) {
    assert.equal(isReliableOrderedChannel({ ordered: true, maxRetransmits: unlimited, maxPacketLifeTime: unlimited }), true)
  }
  assert.equal(isReliableOrderedChannel({ ordered: false, maxRetransmits: null, maxPacketLifeTime: null }), false)
  for (const limited of [0, 1, 100, 65534]) {
    assert.equal(isReliableOrderedChannel({ ordered: true, maxRetransmits: limited, maxPacketLifeTime: 65535 }), false)
    assert.equal(isReliableOrderedChannel({ ordered: true, maxRetransmits: 65535, maxPacketLifeTime: limited }), false)
  }
})

test('native reliable DataChannel opens the session exactly once', () => {
  let opened = 0
  let rejected = 0
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    channels: new Set(), opened: false, closed: false,
    onOpen: () => { opened++ },
  })
  const channel = {
    ordered: true, maxRetransmits: 65535, maxPacketLifeTime: 65535,
    close() { rejected++ },
  }
  media.bindChannel(channel, true)
  assert.equal(rejected, 0)
  channel.onopen()
  channel.onopen()
  assert.equal(opened, 1)
  media.bindChannel({ ...channel, maxRetransmits: 0 }, false)
  assert.equal(rejected, 1)
})

test('native gateway channel is created lazily after the peer is connected', () => {
  const created = []
  const media = Object.assign(Object.create(NativeWebRtcMedia.prototype), {
    channels: new Set(), closed: false, pc: {
      createDataChannel(label, options) {
        const channel = { label, ...options, readyState: 'connecting', close() {} }
        created.push(channel)
        return channel
      },
    },
  })
  media.openEventsChannel()
  media.openEventsChannel()
  assert.equal(created.length, 1)
  assert.equal(created[0].label, 'txt')
  assert.equal(created[0].ordered, true)
  assert.equal(media.events, created[0])
})

test('close fences synchronous send and media cleanup re-entry', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'close-test' })
  const closes = []
  let notifications = 0
  let cleanups = 0
  media.send = () => { notifications++; connection.close(1011, 'send failed') }
  media.close = () => { cleanups++; connection.close(1006, 'media closed') }
  connection.on('close', (code, reason) => closes.push({ code, reason }))
  connection.close(1000, 'requested close')
  connection.close()
  assert.equal(notifications, 1)
  assert.equal(cleanups, 1)
  assert.equal(connection.readyState, 3)
  assert.deepEqual(closes, [{ code: 1000, reason: 'requested close' }])
})

test('a failed closing notification does not prevent cleanup or emit twice', () => {
  const media = new FakeMedia()
  const connection = new WebRtcConnection({ media, provider: testProvider(), sessionId: 'close-failure' })
  let closes = 0
  media.send = () => { throw new Error('closed data channel') }
  connection.on('close', () => { closes++; connection.close() })
  assert.doesNotThrow(() => connection.close())
  assert.equal(media.closed, true)
  assert.equal(connection.readyState, 3)
  assert.equal(closes, 1)
})
