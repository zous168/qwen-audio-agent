/**
 * Maps qwen-audio-agent presentation / Realtime events into Vidu component feeds.
 * The gateway's DigitalHumanOrchestrator now owns this mapping. This small
 * feed remains useful for provider-level tests and standalone protocol probes.
 *
 * Required for Vidu component: PCM (model reply audio) + user ASR (type 9) + assistant text (type 10).
 */

export function createQwenViduPresentationFeed(stream) {
  let activeResponseId = ''

  return {
    onUserTranscriptFinal(text) {
      stream.sendInputTranscription(text)
    },
    onAssistantTranscriptDelta(text) {
      if (!text?.trim()) return
      stream.sendOutputTranscription(text)
    },
    onAssistantAudioDelta({ audio, responseId }) {
      if (responseId && activeResponseId && responseId !== activeResponseId) return
      if (responseId) activeResponseId = responseId
      if (!audio) return
      stream.sendPcm(audio)
    },
    onUserSpeechStarted() {
      stream.interrupt()
    },
    onResponseFinished(responseId) {
      if (!responseId || responseId === activeResponseId) {
        activeResponseId = ''
      }
    },
    close() {
      stream.hangup()
    },
  }
}

/**
 * Compatibility tap for server-side integration tests: subscribe to normalized events
 * from realtime-presentation-runtime (response.output_audio.delta, transcript events).
 */
export function attachPresentationEventTap(emitter, feed) {
  const handlers = {
    'conversation.item.input_audio_transcription.completed': event => {
      feed.onUserTranscriptFinal(event.transcript || '')
    },
    'response.audio_transcript.delta': event => {
      feed.onAssistantTranscriptDelta(event.delta || '')
    },
    'response.output_audio.delta': event => {
      feed.onAssistantAudioDelta({
        audio: event.delta ? Buffer.from(event.delta, 'base64') : null,
        responseId: event.response_id || event.responseId,
      })
    },
    'input_audio_buffer.speech_started': () => {
      feed.onUserSpeechStarted()
    },
    'response.done': event => {
      feed.onResponseFinished(event.response?.id || event.response_id)
    },
  }

  for (const [name, handler] of Object.entries(handlers)) {
    emitter.on(name, handler)
  }

  return () => {
    for (const [name, handler] of Object.entries(handlers)) {
      emitter.off(name, handler)
    }
  }
}
