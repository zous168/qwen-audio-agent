import { EventEmitter } from 'node:events'
import {
  cloneTurnRef,
  normalizeAudioFormat,
  normalizeCancelReason,
  normalizeProviderError,
} from './contracts.mjs'

const RESPONSE_AUDIO_EVENTS = new Set([
  'response.audio.delta',
  'response.output_audio.delta',
])
const RESPONSE_TEXT_EVENTS = new Set([
  'response.audio_transcript.delta',
  'response.output_audio_transcript.delta',
  'response.text.delta',
])
const RESPONSE_TEXT_DONE_EVENTS = new Set([
  'response.audio_transcript.done',
  'response.output_audio_transcript.done',
  'response.text.done',
])
const MAX_AUDIO_CHUNK_BYTES = 512 * 1024

function responseId(event) {
  return String(event?.response_id || event?.responseId || event?.response?.id || '')
}

function pcmFromEvent(event) {
  if (!event?.delta) return null
  if (Buffer.isBuffer(event.delta) || event.delta instanceof Uint8Array) return Buffer.from(event.delta)
  return Buffer.from(String(event.delta), 'base64')
}

function sampleCount(buffer, format) {
  if (!buffer) return 0
  if (buffer.byteLength % 2) throw Object.assign(new Error('digital-human PCM16 chunk is not sample aligned'), { code: 'invalid_media' })
  return buffer.byteLength / 2 / format.channels
}

/**
 * Coordinates one optional provider session with a Realtime connection.
 *
 * Provider implementations are injected by the example/application host. A
 * provider is considered ready only when its control channel and media sink
 * are ready, so the orchestrator can commit to the paired avatar output
 * before suppressing the Realtime audio track.
 */
export class DigitalHumanOrchestrator extends EventEmitter {
  constructor({
    providerFactory,
    persona = null,
    format = undefined,
    mediaOutput = null,
    send = () => {},
    canPresent = () => true,
    logger = null,
    firstMediaTimeoutMs = 3_000,
  } = {}) {
    super()
    if (typeof providerFactory !== 'function') throw new TypeError('digital-human providerFactory is required')
    this.providerFactory = providerFactory
    this.persona = persona
    this.format = normalizeAudioFormat(format)
    this.mediaOutput = mediaOutput
    this.send = send
    this.canPresent = canPresent
    this.logger = logger
    this.firstMediaTimeoutMs = Math.max(250, Number(firstMediaTimeoutMs) || 3_000)
    this.provider = null
    this.session = null
    this.sessionAbort = null
    this.turn = null
    this.sequence = 0
    this.sampleOffset = 0
    this.stateValue = 'starting'
    this.closed = false
    this.ready = false
    this.openPromise = null
    this.eventPump = null
    this.operationChain = Promise.resolve()
    this.operationEpoch = 0
    this.pendingOperations = 0
    this.turnGeneration = 0
    this.failedResponseId = null
  }

  state() {
    return {
      state: this.stateValue,
      ready: this.ready,
      responseId: this.turn?.responseId || null,
      generation: this.turn?.generation ?? null,
    }
  }

  async open({ signal } = {}) {
    if (this.closed) throw Object.assign(new Error('digital-human session is closed'), { code: 'session_closed' })
    if (this.session) return this.session
    if (this.openPromise) return this.openPromise
    this.sessionAbort = new AbortController()
    if (signal) {
      if (signal.aborted) this.sessionAbort.abort(signal.reason)
      else signal.addEventListener('abort', () => this.sessionAbort.abort(signal.reason), { once: true })
    }
    this.setState('starting')
    this.openPromise = Promise.resolve().then(async () => {
      this.provider = await this.providerFactory({
        persona: this.persona,
        format: this.format,
        signal: this.sessionAbort.signal,
        mediaOutput: this.mediaOutput,
      })
      if (this.closed || this.sessionAbort.signal.aborted) {
        throw Object.assign(new Error('digital-human session was closed during startup'), { code: 'session_closed' })
      }
      if (!this.provider || typeof this.provider.openSession !== 'function') {
        throw new TypeError('digital-human provider must expose openSession')
      }
      this.session = await this.provider.openSession({
        persona: this.persona,
        format: this.format,
        signal: this.sessionAbort.signal,
      })
      if (!this.session) throw new Error('digital-human provider returned no session')
      if (this.closed || this.sessionAbort.signal.aborted) {
        try { await this.session.close?.() } catch {}
        this.session = null
        throw Object.assign(new Error('digital-human session was closed during startup'), { code: 'session_closed' })
      }
      this.attachSessionEvents(this.session)
      this.ready = true
      this.setState('ready')
      return this.session
    }).catch(error => {
      const normalized = normalizeProviderError(error)
      this.setState('audio_only', normalized)
      throw normalized
    }).finally(() => {
      this.openPromise = null
    })
    return this.openPromise
  }

  attachSessionEvents(session) {
    const handler = event => this.handleSessionEvent(event)
    if (typeof session.on === 'function') {
      session.on('event', handler)
      session.on('media', event => this.handleSessionEvent({ type: 'media', ...event }))
      session.on('error', error => this.handleSessionEvent({ type: 'provider.error', error }))
      session.on('provider.error', error => this.handleSessionEvent({ type: 'provider.error', error }))
    }
    if (typeof session.events === 'function') {
      this.eventPump = this.consumeEvents(session.events(), handler)
    }
  }

  async consumeEvents(events, handler) {
    try {
      for await (const event of events) {
        if (this.closed) break
        handler(event)
      }
    } catch (error) {
      if (!this.closed) this.handleSessionEvent({ type: 'provider.error', error })
    }
  }

  handleSessionEvent(event = {}) {
    if (this.closed || !this.ready) return
    if (event.type === 'session.ready') {
      this.ready = true
      this.setState('ready')
      return
    }
    if (event.type === 'turn.first_media') {
      if (this.turn && event.responseId && event.responseId !== this.turn.responseId) return
      this.setState('rendering')
      return
    }
    if (event.type === 'turn.completed' || event.type === 'turn.cancelled') {
      if (event.responseId && event.responseId !== this.turn?.responseId) return
      if (event.type === 'turn.completed') this.setState('ready')
      return
    }
    if (event.type === 'provider.error') {
      const error = normalizeProviderError(event.error || event)
      this.logger?.warn?.('digital_human.provider_error', { code: error.code, error: error.message })
      this.fallback(error)
      return
    }
    if (event.type === 'media.audio') {
      if (!this.canPresent()) { void this.interrupt('permission_revoked').catch(() => {}); return }
      this.pushMediaAudio(event)
      return
    }
    if (event.type === 'media.video') {
      if (!this.canPresent()) { void this.interrupt('permission_revoked').catch(() => {}); return }
      this.pushMediaVideo(event)
      return
    }
    this.emit('provider.event', event)
  }

  pushMediaAudio(event) {
    const ref = event.turn || this.turn
    if (!ref || !this.turn || ref.responseId !== this.turn.responseId || ref.generation !== this.turn.generation) return
    if (!this.mediaOutput?.append) return
    const data = Buffer.isBuffer(event.audio) || event.audio instanceof Uint8Array
      ? Buffer.from(event.audio)
      : Buffer.from(String(event.audio || ''), 'base64')
    try {
      this.mediaOutput.append({
        audio: data.toString('base64'),
        sampleRate: Number(event.sampleRate) || this.format.sampleRate,
        responseId: this.turn.responseId,
      })
    } catch (error) {
      const normalized = normalizeProviderError(error, 'invalid_media')
      this.fallback(normalized)
      return
    }
    clearTimeout(this.turn.firstMediaTimer)
    this.turn.firstAudio = true
    this.turn.fallbackAudio = []
    this.turn.firstMedia = true
    this.setState('rendering')
  }

  pushMediaVideo(event) {
    const ref = event.turn || this.turn
    if (!ref || !this.turn || ref.responseId !== this.turn.responseId || ref.generation !== this.turn.generation) return
    if (!this.mediaOutput?.video) return
    try {
      this.mediaOutput.video({
        data: event.data,
        width: event.width,
        height: event.height,
        format: event.format || 'I420',
        rotation: event.rotation || 0,
        responseId: this.turn.responseId,
        generation: this.turn.generation,
      })
    } catch (error) {
      const normalized = normalizeProviderError(error, 'invalid_media')
      this.fallback(normalized)
      return
    }
    this.turn.firstMedia = true
    this.setState('rendering')
  }

  enqueue(operation) {
    const epoch = this.operationEpoch
    this.pendingOperations += 1
    if (this.pendingOperations > 256) {
      this.pendingOperations -= 1
      const error = Object.assign(new Error('digital-human input queue is full'), { code: 'capacity_exhausted' })
      this.fallback(error)
      return Promise.reject(error)
    }
    const run = this.operationChain.then(() => epoch === this.operationEpoch && !this.closed ? operation() : undefined)
    this.operationChain = run.catch(error => {
      if (epoch !== this.operationEpoch || this.closed) return
      const normalized = normalizeProviderError(error)
      this.fallback(normalized)
    }).finally(() => { this.pendingOperations -= 1 })
    return run
  }

  handleProviderEvent(event, context = null) {
    if (this.closed || !this.session) return { suppressAudio: false }
    if (this.failedResponseId && responseId(event) === this.failedResponseId) return { suppressAudio: true, suppressAudioDone: true }
    if (!this.ready) return { suppressAudio: false, suppressAudioDone: false }
    if (!this.canPresent()) {
      void this.interrupt('permission_revoked').catch(() => {})
      return { suppressAudio: false, suppressAudioDone: false }
    }
    if (event.type === 'input_audio_buffer.speech_started') {
      void this.interrupt('user_interruption').catch(() => {})
      return { suppressAudio: false }
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      void this.enqueue(() => this.session?.appendInputText?.({ content: event.transcript || '', timestamp: Date.now() })).catch(() => {})
      return { suppressAudio: false }
    }
    const id = responseId(event)
    if (event.type === 'response.created') {
      if (!id) return { suppressAudio: false }
      if (context?.suppressed) return { suppressAudio: false, suppressAudioDone: false }
      if (this.turn) void this.interrupt('user_interruption').catch(() => {})
      const turnGeneration = Number.isInteger(context?.turnGeneration) ? context.turnGeneration : 0
      this.turn = {
        avatarSessionId: String(this.session.avatarSessionId || 'avatar-session'),
        responseId: id,
        generation: this.turnGeneration = Math.max(turnGeneration, this.turnGeneration) + 1,
        turnId: context?.turnId || null,
        finished: false,
        fallbackAudio: [],
        fallbackBytes: 0,
      }
      const turn = cloneTurnRef(this.turn)
      this.sequence = 0
      this.sampleOffset = 0
      void this.enqueue(() => this.turn?.responseId === turn.responseId
        ? this.session?.startTurn?.(turn)
        : undefined).catch(() => {})
      return { suppressAudio: this.ready && this.session.mediaBinding?.mode === 'paired_av' }
    }
    if (!this.turn || (id && id !== this.turn.responseId)) return { suppressAudio: false }
    if (RESPONSE_AUDIO_EVENTS.has(event.type)) {
      let audio
      try {
        audio = pcmFromEvent(event)
        if (audio?.byteLength > MAX_AUDIO_CHUNK_BYTES) throw Object.assign(new Error('digital-human PCM chunk is too large'), { code: 'capacity_exhausted' })
        if (audio) sampleCount(audio, this.format)
      } catch (error) {
        this.fallback(normalizeProviderError(error, 'invalid_media'))
        return { suppressAudio: false, suppressAudioDone: false }
      }
      if (!audio) return { suppressAudio: this.ready && this.session.mediaBinding?.mode === 'paired_av' }
      if (!this.turn.firstAudio) {
        // Keep original audio until the first rendered audio commits playback.
        // A bridge that emits only video must not swallow the spoken answer.
        this.turn.fallbackAudio.push({ type: 'audio.delta', audio: audio.toString('base64'), sampleRate: Number(event.sampleRate) || this.format.sampleRate, responseId: this.turn.responseId, turnId: this.turn.turnId })
        this.turn.fallbackBytes += audio.length
        if (this.turn.fallbackBytes > 384000) {
          this.fallback(Object.assign(new Error('digital-human prebuffer exceeded'), { code: 'first_media_timeout' }))
          return { suppressAudio: true }
        }
        if (!this.turn.firstMediaTimer) {
          const turn = this.turn
          turn.firstMediaTimer = setTimeout(() => {
            if (this.turn !== turn || turn.firstAudio) return
            this.fallback(Object.assign(new Error('digital-human provider did not produce audio in time'), { code: 'first_media_timeout' }))
          }, this.firstMediaTimeoutMs)
          turn.firstMediaTimer.unref?.()
        }
      }
      this.sequence += 1
      const input = {
        ...cloneTurnRef(this.turn),
        sequence: this.sequence,
        sampleOffset: this.sampleOffset,
        data: audio,
      }
      this.sampleOffset += sampleCount(audio, this.format)
      void this.enqueue(() => this.turn?.responseId === input.responseId
        ? this.session?.appendAudio?.(input)
        : undefined).catch(() => {})
      return { suppressAudio: this.ready && this.session.mediaBinding?.mode === 'paired_av' }
    }
    if (RESPONSE_TEXT_EVENTS.has(event.type)) {
      const turn = cloneTurnRef(this.turn)
      const sequence = ++this.sequence
      void this.enqueue(() => this.turn?.responseId === turn.responseId
        ? this.session?.appendText?.({
        ...turn,
        sequence,
        delta: String(event.delta || ''),
        })
        : undefined).catch(() => {})
      return { suppressAudio: false }
    }
    if (RESPONSE_TEXT_DONE_EVENTS.has(event.type)) {
      const turn = cloneTurnRef(this.turn)
      const sequence = ++this.sequence
      void this.enqueue(() => this.turn?.responseId === turn.responseId
        ? this.session?.appendText?.({
        ...turn,
        sequence,
        delta: String(event.transcript || event.text || ''),
        final: true,
        })
        : undefined).catch(() => {})
      return { suppressAudio: false }
    }
    if (event.type === 'response.done') {
      if (event.response?.status && event.response.status !== 'completed') {
        void this.interrupt('provider_failure').catch(() => {})
        return { suppressAudio: false, suppressAudioDone: false }
      }
      if (this.turn.finished) return { suppressAudio: true, suppressAudioDone: true }
      this.turn.finished = true
      const turn = cloneTurnRef(this.turn)
      void this.enqueue(() => this.turn?.responseId === turn.responseId
        ? Promise.resolve(this.session?.finishTurn?.({
        ...turn,
        lastAudioSequence: this.sequence,
        totalSamples: this.sampleOffset,
        })).then(() => {
        if (this.turn?.responseId !== turn.responseId || this.turn.generation !== turn.generation) return
        if (this.sampleOffset && !this.turn.firstAudio) {
          this.fallback(Object.assign(new Error('digital-human finished without audio'), { code: 'first_media_timeout' }))
          return
        }
        this.mediaOutput?.finish?.(turn.responseId)
        clearTimeout(this.turn.firstMediaTimer)
        this.send({
          type: 'audio.done',
          responseId: turn.responseId,
          ...(this.turn.turnId ? { turnId: this.turn.turnId } : {}),
        })
        this.turn = null
        this.sequence = 0
        this.sampleOffset = 0
        this.setState('ready')
        })
        : undefined).catch(() => {})
      return { suppressAudio: true, suppressAudioDone: true }
    }
    return { suppressAudio: false }
  }

  fallback(error) {
    if (this.closed || !this.ready) return
    this.ready = false
    const turn = this.turn
    // Once rendered audio was audible, stop this response. Replaying it from
    // the beginning would repeat speech. Future turns use the original audio.
    if (turn?.firstAudio) this.failedResponseId = turn.responseId
    const session = this.session
    const cancellation = this.interrupt('provider_failure', { clearMedia: Boolean(turn?.firstAudio) })
    this.sessionAbort?.abort(new Error('digital-human fallback'))
    // Fallback can last for the rest of the conversation. Release the failed
    // paid renderer instead of retaining an idle cloud live indefinitely.
    void cancellation.finally(() => session?.close?.()).catch(() => {})
    if (turn && this.canPresent()) {
      if (turn.firstAudio) this.send({ type: 'playback.clear', reason: 'provider_failure', responseId: turn.responseId })
      else for (const event of turn.fallbackAudio || []) this.send(event)
      if (turn.finished || turn.firstAudio) this.send({ type: 'audio.done', responseId: turn.responseId, turnId: turn.turnId })
    }
    this.setState('audio_only', error)
    this.emit('provider.error', error)
  }

  async interrupt(reason = 'user_interruption', { clearMedia = true } = {}) {
    if (!this.session || !this.turn) return
    const cancelReason = normalizeCancelReason(reason)
    clearTimeout(this.turn.firstMediaTimer)
    const ref = cloneTurnRef(this.turn)
    this.operationEpoch++
    this.turn = null
    this.sequence = 0
    this.sampleOffset = 0
    if (clearMedia) this.mediaOutput?.clear?.(ref.responseId)
    // Interrupt must overtake a pending finish/drain operation. Provider
    // implementations invalidate the turn reference themselves; queued start,
    // append, and finish callbacks also check the cleared reference.
    const cancellation = Promise.resolve(this.session?.interruptTurn?.({ ...ref, reason: cancelReason })).catch(() => {})
    this.operationChain = cancellation
    await cancellation
    if (this.ready && !this.closed && !this.turn && cancelReason !== 'provider_failure') this.setState('ready')
  }

  setState(state, error = null) {
    if (this.stateValue === state && !error) return
    this.stateValue = state
    const event = {
      type: 'digital_human.state',
      state,
      ...(error ? { error: { code: error.code || 'unavailable' } } : {}),
    }
    this.send(event)
    this.emit('state', event)
  }

  async close(reason = 'session_closed') {
    if (this.closed) return
    this.closed = true
    this.sessionAbort?.abort(new Error(reason))
    clearTimeout(this.turn?.firstMediaTimer)
    this.turn = null
    this.sequence = 0
    this.sampleOffset = 0
    this.mediaOutput?.clear?.()
    try { await this.session?.close?.() } catch (error) { this.logger?.warn?.('digital_human.close_failed', { error: error.message }) }
    this.session = null
    this.provider = null
    this.ready = false
    this.setState('closed')
  }
}
