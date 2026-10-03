import { encodeWebRtcMessage, WebRtcMessageReader, GATEWAY_WEBRTC_MESSAGE_BYTES } from './webrtc-message.mjs'

// Browser transport only. No tools, prompts or visual-observation policy.
// Shared by the minimal WebRTC page and the X-Omni presentation.
export class BrowserWebRtcConnection {
  constructor({ sessionId, clientActions = [], takeover = false, fetch: request = globalThis.fetch,
    onEvent = () => {}, onState = () => {}, onError = () => {}, onPlayback = () => {}, audio = null,
    video = null, avatarPersonaId = '', mediaDevices = globalThis.navigator?.mediaDevices,
    protocol = 'realtime', onOpen = () => {}, onClose = () => {}, onVideoStream = () => {} } = {}) {
    Object.assign(this, { sessionId, clientActions, takeover, request, onEvent, onState, onError, onPlayback, video, avatarPersonaId, mediaDevices })
    this.audio = audio || document.createElement('audio')
    this.audio.autoplay = true
    this.audio.muted = false
    this.audio.setAttribute('playsinline', '')
    this.outputs = new Map()
    this.abort = new AbortController()
    this.ready = false
    this.closed = false
    this.microphoneEnabled = false
    this.videoGeneration = 0
    Object.assign(this, { protocol, onOpen, onClose, onVideoStream })
    this.messages = new WebRtcMessageReader(protocol === 'gateway' ? { maxBytes: GATEWAY_WEBRTC_MESSAGE_BYTES, timeoutMs: 30000 } : {})
    this.outgoing = []
    this.outgoingBytes = 0
    this.outputMuted = false
  }

  async connect() {
    this.onState('connecting')
    try {
      const response = await this.request('/api/v1/webrtc/config', { signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10000)]) })
      const config = await response.json()
      if (!response.ok) throw new Error(config.error?.message || 'Cannot read WebRTC configuration')
      if (this.closed) return
      this.config = config
      this.context = new AudioContext()
      this.pc = new RTCPeerConnection({ iceServers: config.iceServers, iceTransportPolicy: config.iceTransportPolicy })
      // GCP retains the application's existing PCM capture, wake-word and
      // visual-input paths. Only presentation media uses RTP in this mode.
      this.audioSender = this.pc.addTransceiver('audio', { direction: this.protocol === 'gateway' ? 'recvonly' : 'sendrecv' }).sender
      const videoOutput = Boolean(this.avatarPersonaId && config.video_output)
      const videoInput = config.video_input && this.protocol !== 'gateway'
      if (videoInput || videoOutput) {
        const direction = videoInput ? (videoOutput ? 'sendrecv' : 'sendonly') : 'recvonly'
        const transceiver = this.pc.addTransceiver('video', { direction })
        if (videoInput) this.videoSender = transceiver.sender
        if (videoOutput) this.videoReceiver = transceiver.receiver
      }
      this.pc.onconnectionstatechange = () => {
        clearTimeout(this.disconnectTimer)
        if (this.pc.connectionState === 'failed') this.fail(new Error('WebRTC media connection failed'))
        if (this.pc.connectionState === 'disconnected') this.disconnectTimer = setTimeout(() => this.fail(new Error('WebRTC media connection lost')), 10000)
      }
      const bindChannel = channel => {
        if (this.closed) return
        this.channel = channel
        const opened = () => { if (!this.closed) this.onOpen() }
        channel.onopen = opened
        if (channel.readyState === 'open') opened()
        channel.onmessage = ({ data }) => {
          try {
            const message = this.messages.read(data)
            if (message !== null) this.received(JSON.parse(message))
          } catch (error) { this.fail(error) }
        }
        channel.onclose = () => { if (!this.closed) this.fail(new Error('WebRTC control channel closed')) }
      }
      this.pc.ondatachannel = ({ channel }) => { if (channel.label === 'txt') bindChannel(channel) }
      // A bidirectional channel lets SCTP assign the stream id from the
      // negotiated DTLS role and carries control messages in both directions.
      bindChannel(this.pc.createDataChannel('oai-events', { ordered: true }))
      this.pc.ontrack = ({ track }) => {
        if (this.closed) return
        if (track.kind === 'video') {
          this.onVideoStream(new MediaStream([track]))
          if (!this.video) return
          this.video.srcObject = new MediaStream([track])
          this.video.play().catch(() => {})
          return
        }
        if (track.kind !== 'audio') return
        const stream = new MediaStream([track])
        this.audio.srcObject = stream
        const source = this.context.createMediaStreamSource(stream)
        this.analyser = this.context.createAnalyser()
        this.analyser.fftSize = 1024
        this.samples = new Float32Array(this.analyser.fftSize)
        source.connect(this.analyser)
        this.audio.play().catch(() => { if (!this.closed) this.onError(Object.assign(new Error('Click the microphone or Send button to enable audio playback.'), { code: 'playback_blocked' })) })
      }
      this.playbackMeter = setInterval(() => this.measurePlayback(), 50)
      this.connectTimer = setTimeout(() => this.fail(new Error('WebRTC connection timed out')), 25000)
      await this.pc.setLocalDescription(await this.pc.createOffer())
      await this.gatherIce()
      if (this.closed) return
      const query = new URLSearchParams({ sessionId: this.sessionId, model: config.model })
      query.set('control_channel', 'duplex')
      if (this.protocol === 'gateway') query.set('protocol', 'gateway')
      if (this.avatarPersonaId) query.set('avatarPersonaId', this.avatarPersonaId)
      if (this.clientActions.length) query.set('client_actions', JSON.stringify(this.clientActions))
      if (this.takeover) query.set('takeover', 'true')
      const answer = await this.request(`/api/v1/webrtc/realtime?${query}`, {
        method: 'POST', headers: { 'Content-Type': 'application/sdp' },
        body: this.pc.localDescription.sdp, signal: this.abort.signal,
      })
      if (!answer.ok) throw new Error((await answer.json()).error?.message || `HTTP ${answer.status}`)
      this.location = answer.headers.get('Location')
      if (this.closed) { await this.release(); return }
      await this.pc.setRemoteDescription({ type: 'answer', sdp: await answer.text() })
    } catch (error) { if (!this.closed) this.fail(error) }
  }

  gatherIce() {
    if (this.pc.iceGatheringState === 'complete') return Promise.resolve()
    return new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer)
        this.pc.removeEventListener('icegatheringstatechange', changed)
        this.abort.signal.removeEventListener('abort', cancelled)
        error ? reject(error) : resolve()
      }
      const changed = () => { if (this.pc.iceGatheringState === 'complete') finish() }
      const cancelled = () => finish(new Error('Connection closed'))
      const timer = setTimeout(() => finish(new Error('ICE gathering timed out')), 12000)
      this.pc.addEventListener('icegatheringstatechange', changed)
      this.abort.signal.addEventListener('abort', cancelled, { once: true })
      changed()
    })
  }

  send(event) {
    if (this.closed || this.channel?.readyState !== 'open') return false
    try {
      const frames = encodeWebRtcMessage({ event_id: crypto.randomUUID(), ...event }, this.protocol === 'gateway' ? { maxBytes: GATEWAY_WEBRTC_MESSAGE_BYTES } : {})
      const bytes = frames.reduce((size, frame) => size + new TextEncoder().encode(frame).length, 0)
      if (this.protocol === 'gateway') {
        if (this.outgoingBytes + bytes > 24 * 1024 * 1024) throw new Error('WebRTC command queue is full')
        this.outgoing.push(...frames.map(frame => ({ frame, bytes: new TextEncoder().encode(frame).length })))
        this.outgoingBytes += bytes
        this.flushOutgoing()
        return true
      }
      if (this.channel.bufferedAmount + bytes > 1024 * 1024) throw new Error('WebRTC control channel is congested')
      for (const frame of frames) this.channel.send(frame)
      return true
    } catch (error) { this.fail(error); return false }
  }
  flushOutgoing() {
    clearTimeout(this.sendTimer)
    if (this.closed || this.channel?.readyState !== 'open') return
    try {
      while (this.outgoing.length && this.channel.bufferedAmount < 256 * 1024) {
        const item = this.outgoing.shift()
        this.outgoingBytes -= item.bytes
        this.channel.send(item.frame)
      }
      if (this.outgoing.length) this.sendTimer = setTimeout(() => this.flushOutgoing(), 10)
    } catch (error) { this.fail(error) }
  }
  command(event) { return this.send({ type: 'qwaudio.command', event: { event_id: crypto.randomUUID(), ...event } }) }
  receipt(type, responseId) {
    return this.send(this.protocol === 'gateway'
      ? { type: `playback.${type}`, responseId, ...(type === 'cancelled' ? { reason: 'user_interruption' } : {}) }
      : { type: `qwaudio.playback.${type}`, response_id: responseId })
  }

  received(event) {
    if (this.closed) return
    if (event.type === 'session.updated' || (this.protocol === 'gateway' && event.type === 'session.ready')) {
      clearTimeout(this.connectTimer)
      this.ready = true
      this.updateMicrophone()
      this.onState('connected')
    } else if (event.type === 'qwaudio.output.started') {
      this.outputs.set(event.response_id, { started: false, drained: 0, quiet: 0 })
    } else if (event.type === 'qwaudio.output.drained') {
      const output = this.outputs.get(event.response_id)
      if (output) output.drained = performance.now()
    } else if (['output_audio_buffer.cleared', 'playback.clear', 'response.interrupted'].includes(event.type)) this.clearPlayback()
    else if (event.type === 'qwaudio.event') {
      const item = event.event
      if (['input.suspend', 'input.resume'].includes(item.type)) {
        this.suspended = item.type === 'input.suspend'
        this.updateMicrophone()
      }
      if (item.type === 'voice.connection' && item.state !== 'connected') {
        this.ready = false
        this.updateMicrophone()
        this.onState(item.state === 'connecting' ? 'connecting' : 'disconnected')
      }
    }
    this.onEvent(event)
    if (event.type === 'qwaudio.connection.closed') void this.close(event.code, event.reason)
  }

  async activateAudio() {
    if (this.closed) return
    await this.context?.resume()
    if (this.audio.srcObject) await this.audio.play()
  }
  updateMicrophone() {
    for (const track of this.microphone?.getAudioTracks() || []) track.enabled = this.ready && this.microphoneEnabled && !this.suspended
    if (this.videoSender?.track) this.videoSender.track.enabled = this.ready && !this.suspended
  }
  async setMicrophoneEnabled(enabled) {
    this.microphoneEnabled = enabled
    this.updateMicrophone()
    if (!enabled || this.closed || !this.audioSender) return
    // The same stream is retained while muted; overlapping permission prompts
    // and late getUserMedia results may not resurrect a closed connection.
    if (!this.microphone && !this.microphoneRequest) {
      this.microphoneRequest = this.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      }).then(async stream => {
        if (this.closed) { stream.getTracks().forEach(track => track.stop()); return }
        this.microphone = stream
        this.updateMicrophone()
        await this.audioSender.replaceTrack(stream.getAudioTracks()[0])
      }).finally(() => { this.microphoneRequest = null })
    }
    await this.microphoneRequest
  }

  async setVideoTrack(track) {
    if (this.closed || !this.videoSender) return
    if (track) track.enabled = this.ready && !this.suspended
    await this.videoSender.replaceTrack(track)
  }
  sendImageFrame(image) {
    if (!this.ready || this.closed || this.suspended || !this.videoSender || this.framePending) return false
    const generation = this.videoGeneration
    this.framePending = true
    const bitmap = new Image()
    bitmap.onload = async () => {
      try {
        if (this.closed || generation !== this.videoGeneration || this.suspended) return
        if (!this.canvas) {
          this.canvas = document.createElement('canvas')
          Object.assign(this.canvas, { width: 640, height: 480 })
        }
        const context = this.canvas.getContext('2d')
        const scale = Math.min(640 / bitmap.width, 480 / bitmap.height)
        context.clearRect(0, 0, 640, 480)
        context.drawImage(bitmap, (640 - bitmap.width * scale) / 2, (480 - bitmap.height * scale) / 2, bitmap.width * scale, bitmap.height * scale)
        if (!this.canvasStream) this.canvasStream = this.canvas.captureStream(0)
        const track = this.canvasStream.getVideoTracks()[0]
        await this.setVideoTrack(track)
        if (!this.closed && generation === this.videoGeneration && !this.suspended) track.requestFrame()
      } catch (error) { if (!this.closed) this.onError(error) }
      finally { this.framePending = false }
    }
    bitmap.onerror = () => { this.framePending = false; if (!this.closed) this.onError(new Error('Invalid visual frame')) }
    bitmap.src = `data:image/jpeg;base64,${image}`
    return true
  }
  clearVideo() {
    this.videoGeneration++
    for (const track of this.canvasStream?.getTracks() || []) track.stop()
    this.canvasStream = null
    if (!this.closed) {
      this.setVideoTrack(null).catch(error => this.onError(error))
      this.command({ type: 'input_image_buffer.clear' })
    }
  }

  measurePlayback() {
    // Muted/autoplay-blocked and silent responses also need a terminal receipt
    // or the shared session remains stuck waiting for playback forever.
    const audible = this.analyser && !this.audio.paused && !this.audio.muted && this.context.state === 'running'
    const level = audible ? this.outputLevel() : 0
    const first = this.outputs.entries().next().value
    if (!first) return
    const [id, output] = first
    const now = performance.now()
    if (level > 0.002) {
      output.quiet = 0
      if (!output.started) { output.started = true; this.receipt('started', id); this.onPlayback('speaking') }
    } else output.quiet ||= now
    if (!output.started && output.drained && now - output.drained > 1500) {
      this.receipt('cancelled', id)
      this.outputs.delete(id)
      if (!this.outputs.size) this.onPlayback('idle')
      return
    }
    if (output.started && output.drained && now - output.drained > 500 && output.quiet && now - output.quiet > 300) {
      this.receipt('ended', id)
      this.outputs.delete(id)
      if (!this.outputs.size) this.onPlayback('idle')
    }
  }
  outputLevel() {
    if (!this.analyser) return 0
    this.analyser.getFloatTimeDomainData(this.samples)
    return Math.sqrt(this.samples.reduce((sum, value) => sum + value * value, 0) / this.samples.length)
  }
  clearPlayback() {
    for (const id of this.outputs.keys()) this.receipt('cancelled', id)
    this.outputs.clear()
    this.onPlayback('idle')
    this.audio.muted = true
    clearTimeout(this.unmuteTimer)
    this.unmuteTimer = setTimeout(() => { if (!this.closed) this.audio.muted = this.outputMuted }, 400)
  }
  setOutputMuted(muted) { this.outputMuted = Boolean(muted); this.audio.muted = this.outputMuted }
  interrupt() { this.clearPlayback(); return this.send({ type: 'response.cancel' }) }
  fail(error) { this.onError(error); void this.close(1006, 'transport lost') }
  async release() {
    const location = this.location
    this.location = null
    if (location) await this.request(location, { method: 'DELETE', signal: AbortSignal.timeout(3000) }).catch(() => {})
  }
  close(code = 1000, reason = 'closed') {
    if (this.closed) return this.closing || Promise.resolve()
    this.closed = true
    this.ready = false
    this.abort.abort()
    this.messages.clear()
    clearInterval(this.playbackMeter)
    for (const timer of [this.connectTimer, this.disconnectTimer, this.unmuteTimer, this.sendTimer]) clearTimeout(timer)
    this.outgoing = []
    this.outgoingBytes = 0
    this.clearVideo()
    for (const track of this.microphone?.getTracks() || []) track.stop()
    this.pc?.close()
    this.audio.pause()
    this.audio.srcObject = null
    if (this.video) {
      this.video.pause?.()
      this.video.srcObject = null
    }
    this.outputs.clear()
    this.onVideoStream(null)
    this.onState('disconnected')
    this.onClose({ code, reason })
    this.closing = Promise.all([this.context?.close().catch(() => {}), this.release()])
    return this.closing
  }
}
