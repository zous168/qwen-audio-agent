import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { DigitalHumanOrchestrator } from '../src/voice/digital-human/orchestrator.mjs'

function providerHarness() {
  const calls = []
  const media = { appended: [], finished: [], cleared: 0,
    append(event) { this.appended.push(event) },
    finish(id) { this.finished.push(id) },
    clear() { this.cleared += 1 },
  }
  const session = Object.assign(new EventEmitter(), {
    avatarSessionId: 'avatar-1',
    mediaBinding: { mode: 'paired_av' },
    async startTurn(ref) { calls.push(['start', ref]) },
    async appendAudio(input) { calls.push(['audio', input]) },
    async appendText(input) { calls.push(['text', input]) },
    async finishTurn(input) { calls.push(['finish', input]) },
    async interruptTurn(input) { calls.push(['interrupt', input]) },
    async close() { calls.push(['close']) },
  })
  const provider = { async openSession() { return session } }
  return { calls, media, session, provider }
}

test('digital-human orchestrator routes Qwen output and suppresses duplicate audio', async () => {
  const h = providerHarness()
  const states = []
  const orchestrator = new DigitalHumanOrchestrator({
    providerFactory: async () => h.provider,
    mediaOutput: h.media,
    send: event => states.push(event),
  })
  await orchestrator.open()
  assert.equal(orchestrator.state().ready, true)
  assert.equal(orchestrator.handleProviderEvent({ type: 'response.created', response: { id: 'r1' } }, { turnGeneration: 4 }).suppressAudio, true)
  const pcm = Buffer.alloc(8).toString('base64')
  assert.equal(orchestrator.handleProviderEvent({ type: 'response.output_audio.delta', response_id: 'r1', delta: pcm }).suppressAudio, true)
  orchestrator.handleProviderEvent({ type: 'response.audio_transcript.delta', response_id: 'r1', delta: 'hello' })
  await orchestrator.operationChain
  h.session.emit('media', { type: 'media.audio', turn: h.calls[0][1], audio: Buffer.alloc(8), sampleRate: 24000 })
  orchestrator.handleProviderEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } })
  await orchestrator.operationChain
  assert.deepEqual(h.calls.map(call => call[0]), ['start', 'audio', 'text', 'finish'])
  assert.equal(h.calls[1][1].sampleOffset, 0)
  assert.equal(h.calls[1][1].generation, 5)
  assert.deepEqual(h.media.finished, ['r1'])
  assert.ok(states.some(event => event.type === 'audio.done' && event.responseId === 'r1'))
  assert.ok(states.some(event => event.type === 'digital_human.state' && event.state === 'ready'))
})

test('digital-human orchestrator invalidates the active turn on interruption', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media })
  await orchestrator.open()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' }, { turnGeneration: 1 })
  orchestrator.handleProviderEvent({ type: 'input_audio_buffer.speech_started' })
  await orchestrator.operationChain
  assert.equal(orchestrator.state().responseId, null)
  assert.equal(h.media.cleared, 1)
  assert.equal(h.calls.at(-1)[0], 'interrupt')
  assert.equal(h.calls.at(-1)[1].reason, 'user_interruption')
})

test('digital-human provider failure keeps the session in audio-only fallback', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media })
  await orchestrator.open()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' })
  h.session.emit('provider.error', Object.assign(new Error('bridge lost'), { code: 'transport_lost' }))
  await new Promise(resolve => setTimeout(resolve, 0))
  assert.equal(orchestrator.state().state, 'audio_only')
  assert.equal(orchestrator.state().ready, false)
  assert.equal(h.media.cleared, 0)
})

test('precommit failure replays buffered original speech and bypasses future avatar turns', async () => {
  const h = providerHarness()
  const sent = []
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media, send: event => sent.push(event) })
  await orchestrator.open()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' })
  const pcm = Buffer.alloc(8).toString('base64')
  orchestrator.handleProviderEvent({ type: 'response.audio.delta', response_id: 'r1', delta: pcm })
  h.session.emit('provider.error', new Error('bridge lost'))
  assert.deepEqual(sent.filter(event => event.type === 'audio.delta').map(event => event.audio), [pcm])
  assert.equal(h.media.cleared, 0, 'must not block the response before fallback audio')
  assert.equal(orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r2' }).suppressAudio, false)
  assert.equal(orchestrator.handleProviderEvent({ type: 'response.done', response_id: 'r2' }).suppressAudioDone, false)
  await orchestrator.close()
})

test('first-audio timeout starts with PCM and video alone cannot cancel it', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: { ...h.media, video() {} }, firstMediaTimeoutMs: 250 })
  await orchestrator.open()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' })
  await new Promise(resolve => setTimeout(resolve, 280))
  assert.equal(orchestrator.state().ready, true)
  orchestrator.handleProviderEvent({ type: 'response.audio.delta', response_id: 'r1', delta: 'AAAAAA==' })
  await orchestrator.operationChain
  h.session.emit('media', { type: 'media.video', turn: h.calls[0][1], data: Buffer.alloc(6), width: 2, height: 2 })
  await new Promise(resolve => setTimeout(resolve, 280))
  assert.equal(orchestrator.state().state, 'audio_only')
  await orchestrator.close()
})

test('late media cannot resurrect a closed or failed avatar session', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media })
  await orchestrator.open()
  await orchestrator.close()
  h.session.emit('event', { type: 'session.ready' })
  h.session.emit('media', { type: 'media.audio', audio: Buffer.alloc(4) })
  assert.equal(orchestrator.state().state, 'closed')
  assert.equal(h.media.appended.length, 0)
})

test('a rejected drain from an interrupted turn cannot fail the replacement turn', async () => {
  const h = providerHarness()
  let rejectDrain
  h.session.finishTurn = () => new Promise((_, reject) => { rejectDrain = reject })
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media })
  await orchestrator.open()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' })
  orchestrator.handleProviderEvent({ type: 'response.done', response: { id: 'r1', status: 'completed' } })
  await new Promise(resolve => setTimeout(resolve, 0))
  await orchestrator.interrupt()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r2' })
  rejectDrain(new Error('old drain failed'))
  await orchestrator.operationChain
  assert.equal(orchestrator.state().ready, true)
  assert.equal(orchestrator.state().responseId, 'r2')
  await orchestrator.close()
})

test('digital-human orchestrator ignores suppressed Realtime responses', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media })
  await orchestrator.open()
  const result = orchestrator.handleProviderEvent(
    { type: 'response.created', response_id: 'suppressed' },
    { suppressed: true },
  )
  assert.deepEqual(result, { suppressAudio: false, suppressAudioDone: false })
  assert.equal(orchestrator.state().responseId, null)
  assert.deepEqual(h.calls, [])
})

test('digital-human orchestrator never presents while voice output is inactive', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({
    providerFactory: async () => h.provider,
    mediaOutput: h.media,
    canPresent: () => false,
  })
  await orchestrator.open()
  const result = orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' })
  assert.deepEqual(result, { suppressAudio: false, suppressAudioDone: false })
  assert.equal(orchestrator.state().responseId, null)
})

test('digital-human orchestrator rejects malformed or oversized PCM without throwing', async () => {
  const h = providerHarness()
  const orchestrator = new DigitalHumanOrchestrator({ providerFactory: async () => h.provider, mediaOutput: h.media })
  await orchestrator.open()
  orchestrator.handleProviderEvent({ type: 'response.created', response_id: 'r1' })
  const result = orchestrator.handleProviderEvent({ type: 'response.output_audio.delta', response_id: 'r1', delta: Buffer.from([1]).toString('base64') })
  assert.equal(result.suppressAudio, false)
  assert.equal(orchestrator.state().state, 'audio_only')
})
