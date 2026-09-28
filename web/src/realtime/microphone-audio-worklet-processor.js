// This standalone, import-free asset is loaded by audioWorklet.addModule().
// Emit it as a same-origin script so the desktop's strict CSP allows it.

class MicrophoneAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // Batch 40 ms of audio instead of sending each 128-frame render quantum.
    this.samples = new Float32Array(Math.max(1, Math.round(sampleRate * 0.04)))
    this.offset = 0
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0]
    if (input?.length) {
      let consumed = 0
      while (consumed < input.length) {
        const count = Math.min(input.length - consumed, this.samples.length - this.offset)
        this.samples.set(input.subarray(consumed, consumed + count), this.offset)
        consumed += count
        this.offset += count
        if (this.offset === this.samples.length) {
          const samples = this.samples
          this.samples = new Float32Array(samples.length)
          this.offset = 0
          this.port.postMessage({ type: 'samples', samples: samples.buffer }, [samples.buffer])
        }
      }
    }

    // Keep the graph alive without routing microphone audio back to speakers.
    for (const channel of outputs[0] || []) channel.fill(0)
    return true
  }
}

registerProcessor(
  'qwen-audio-microphone',
  MicrophoneAudioWorkletProcessor,
)
