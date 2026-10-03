import { EventEmitter } from 'node:events'
import {
  createExternalLive,
  getLive,
  openExternalLiveStream,
} from './vidu-external-live-client.mjs'

const FRAME_BYTES_20MS = 960

function copyBuffer(value) {
  return Buffer.isBuffer(value) || value instanceof Uint8Array ? Buffer.from(value) : Buffer.from(value || [])
}

function incrementalText(previous, next) {
  const value = String(next || '')
  if (!previous) return value
  if (value.startsWith(previous)) return value.slice(previous.length)
  return value === previous ? '' : value
}

class PcmFrameBuffer {
  constructor(send) {
    this.send = send
    this.buffer = Buffer.alloc(0)
  }

  push(data) {
    const bytes = copyBuffer(data)
    if (!bytes.length) return
    this.buffer = Buffer.concat([this.buffer, bytes])
    while (this.buffer.length >= FRAME_BYTES_20MS) {
      this.send(this.buffer.subarray(0, FRAME_BYTES_20MS))
      this.buffer = this.buffer.subarray(FRAME_BYTES_20MS)
    }
  }

  flush() {
    if (!this.buffer.length) return
    this.send(this.buffer)
    this.buffer = Buffer.alloc(0)
  }

  clear() { this.buffer = Buffer.alloc(0) }
}

/**
 * Provider adapter for Vidu Avatar Component Edition.
 *
 * Vidu emits the rendered RTC track through a vendor RTC SDK. The SDK is
 * deliberately injected as mediaBridgeFactory so the Gateway core and this
 * adapter do not depend on ARTC/TRTC/Agora/Volcengine native packages.
 */
export class ViduDigitalHumanProvider {
  constructor({ config, persona, mediaBridgeFactory, logger = null, fetchImpl = fetch, webSocket }) {
    this.config = { ...config, avatar: persona?.avatar || config.avatar }
    this.persona = persona
    this.mediaBridgeFactory = mediaBridgeFactory
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.webSocket = webSocket
  }

  async capabilities() {
    return {
      version: 1,
      streamingAudio: true,
      inputAudioFormats: [{ encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1 }],
      textInput: 'optional',
      interrupt: true,
      idle: false,
      outputModes: ['paired_av'],
    }
  }

  async openSession({ signal } = {}) {
    if (typeof this.mediaBridgeFactory !== 'function') {
      throw Object.assign(new Error('Vidu RTC media bridge is not configured'), { code: 'unavailable' })
    }
    const created = await createExternalLive(this.config, { fetchImpl: this.fetchImpl, signal })
    if (signal?.aborted) throw signal.reason || new Error('Vidu session aborted')
    const session = new ViduDigitalHumanSession({
      config: this.config,
      created,
      mediaBridgeFactory: this.mediaBridgeFactory,
      logger: this.logger,
      fetchImpl: this.fetchImpl,
      webSocket: this.webSocket,
    })
    try {
      await session.open({ signal })
    } catch (error) {
      await session.close().catch(() => {})
      throw error
    }
    return session
  }
}

export class ViduDigitalHumanSession extends EventEmitter {
  constructor({ config, created, mediaBridgeFactory, logger, fetchImpl, webSocket }) {
    super()
    this.config = config
    this.created = created
    this.mediaBridgeFactory = mediaBridgeFactory
    this.logger = logger
    this.fetchImpl = fetchImpl
    this.webSocket = webSocket
    this.avatarSessionId = created.liveId
    this.mediaBinding = Object.freeze({
      mode: 'paired_av',
      protocol: 'vidu-s-avatar-component',
      liveId: created.liveId,
      traceId: created.traceId || null,
    })
    this.stream = null
    this.bridge = null
    this.currentTurn = null
    this.textByResponse = new Map()
    this.closed = false
    this.pcm = null
  }

  async open({ signal } = {}) {
    const emitMediaAudio = audio => {
      if (!this.currentTurn || this.closed) return
      const data = audio.data || audio
      this.receivedAudioMs += copyBuffer(data).byteLength / 2 / (Number(audio.sampleRate) || 24000) * 1000
      this.lastAudioAt = Date.now()
      this.emit('media', {
        type: 'media.audio',
        turn: this.currentTurn,
        audio: audio.data || audio,
        sampleRate: Number(audio.sampleRate) || 24_000,
      })
    }
    const emitMediaVideo = frame => {
      if (!this.currentTurn) return
      this.emit('media', {
        type: 'media.video',
        turn: this.currentTurn,
        ...frame,
      })
    }
    this.stream = await openExternalLiveStream(this.config, {
      liveId: this.created.liveId,
      clientSecret: this.created.clientSecret,
    }, {
      signal,
      WebSocket: this.webSocket,
      onSignal: message => this.emit('signal', message),
      onForceHangup: hangup => this.emit('provider.error', Object.assign(new Error(`Vidu forced hangup: ${hangup?.hangup_reason || 'unknown'}`), { code: 'unavailable' })),
      onClose: () => {
        if (!this.closed) this.emit('provider.error', Object.assign(new Error('Vidu WebSocket closed'), { code: 'transport_lost' }))
      },
      onError: error => { if (!this.closed) this.emit('provider.error', error) },
    })
    this.bridge = await this.mediaBridgeFactory({
      rtcInfo: this.config.rtcInfo,
      live: this.created.live,
      liveId: this.created.liveId,
      signal,
      onAudio: emitMediaAudio,
      onVideo: emitMediaVideo,
    })
    if (!this.bridge || typeof this.bridge.close !== 'function') {
      throw Object.assign(new Error('Vidu media bridge must expose close()'), { code: 'unavailable' })
    }
    if (signal?.aborted || !this.stream.isReady()) throw new Error('Vidu session closed during RTC startup')
    this.pcm = new PcmFrameBuffer(buffer => this.stream?.sendPcm(buffer))
    this.emit('event', { type: 'session.ready' })
  }

  async appendInputText({ content }) {
    this.stream?.sendInputTranscription(content)
  }

  async startTurn(ref) {
    this.currentTurn = { ...ref }
    this.receivedAudioMs = 0
    this.lastAudioAt = 0
    this.textByResponse.set(ref.responseId, '')
    this.emit('event', { type: 'turn.started', ...ref })
  }

  async appendAudio(input) {
    if (!this.currentTurn || input.responseId !== this.currentTurn.responseId || input.generation !== this.currentTurn.generation) return
    this.pcm?.push(input.data)
  }

  async appendText(input) {
    if (!this.currentTurn || input.responseId !== this.currentTurn.responseId || input.generation !== this.currentTurn.generation) return
    const previous = this.textByResponse.get(input.responseId) || ''
    const content = input.final ? incrementalText(previous, input.delta) : String(input.delta || '')
    if (!content) return
    this.textByResponse.set(input.responseId, previous + content)
    this.stream?.sendOutputTranscription(content)
  }

  async finishTurn(ref) {
    if (!this.currentTurn || ref.responseId !== this.currentTurn.responseId) return
    const turn = { ...this.currentTurn }
    this.pcm?.flush()
    // Sending the last PCM bytes is not a media drain. Wait for the bridge's
    // barrier, or for the expected audio duration and a quiet tail, with a
    // deadline so a stalled RTC subscriber cannot retain the turn forever.
    if (typeof this.bridge?.waitForDrain === 'function') {
      let timer
      try {
        await Promise.race([
          this.bridge.waitForDrain({ responseId: ref.responseId, timeoutMs: 15_000 }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Vidu RTC drain timed out')), 15000) }),
        ])
      } finally { clearTimeout(timer) }
    } else {
      const expectedMs = (Number(ref.totalSamples) || 0) / 24000 * 1000
      const deadline = Date.now() + Math.min(60000, Math.max(15000, expectedMs + 5000))
      while (expectedMs && !this.closed) {
        if (this.currentTurn?.responseId !== turn.responseId || this.currentTurn?.generation !== turn.generation) return
        if (this.receivedAudioMs >= expectedMs * 0.98 && Date.now() - this.lastAudioAt >= 250) break
        if (Date.now() > deadline) throw new Error('Vidu RTC drain timed out')
        await new Promise(resolve => setTimeout(resolve, 50))
      }
    }
    // An interruption may have replaced this turn while the drain barrier was
    // pending. Do not emit completion or clear the replacement turn.
    if (!this.currentTurn || this.currentTurn.responseId !== turn.responseId) return
    this.emit('event', { type: 'turn.completed', ...turn })
    this.currentTurn = null
    this.textByResponse.delete(ref.responseId)
  }

  async interruptTurn(ref) {
    if (!this.currentTurn || ref.responseId !== this.currentTurn.responseId) return
    this.pcm?.clear()
    this.stream?.interrupt()
    this.emit('event', { type: 'turn.cancelled', ...this.currentTurn })
    this.currentTurn = null
    this.textByResponse.delete(ref.responseId)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.pcm?.clear()
    try { this.stream?.hangup('client_hangup') } catch (error) { this.logger?.warn?.('vidu.stream_close_failed', { error: error.message }) }
    try { await this.bridge?.close?.() } catch (error) { this.logger?.warn?.('vidu.rtc_close_failed', { error: error.message }) }
    this.stream = null
    this.bridge = null
    this.currentTurn = null
  }

  async getLive() {
    return getLive(this.config, this.avatarSessionId, { fetchImpl: this.fetchImpl })
  }
}

export function createViduDigitalHuman({ config, mediaBridgeFactory, logger = null, fetchImpl = fetch, webSocket } = {}) {
  const personaId = config?.personaId || 'default'
  const persona = {
    id: personaId,
    label: config?.personaLabel || 'Vidu Avatar',
    avatar: config?.avatar,
  }
  const available = Boolean(config && typeof mediaBridgeFactory === 'function')
  return {
    available,
    personas: () => available ? [{ id: persona.id, label: persona.label }] : [],
    resolvePersona: id => available && id === persona.id ? persona : null,
    format: { encoding: 'pcm_s16le', sampleRate: 24_000, channels: 1 },
    providerFactory: context => new ViduDigitalHumanProvider({
      config,
      persona: context.persona || persona,
      mediaBridgeFactory,
      logger,
      fetchImpl,
      webSocket,
    }),
  }
}
