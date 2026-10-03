import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { rtcHarness, waitUntil } from './fixtures/webrtc-gateway.mjs'

const enabled = process.env.QWAUDIO_TEST_WEBRTC_NATIVE === '1'

for (const desktop of [false, true]) {
  test(`shared ${desktop ? 'desktop panel' : 'WebUI'}: avatar RTP, one session, transcript, fallback and switching`, { skip: !enabled, timeout: 60000 }, async t => {
    const sessions = []
    const digitalHuman = {
      available: true, personas: () => [{ id: 'test-avatar', label: 'Test Avatar' }],
      resolvePersona: id => id === 'test-avatar' ? { id } : null,
      providerFactory: async () => ({ async openSession() {
        const session = Object.assign(new EventEmitter(), {
          avatarSessionId: `mock-${sessions.length}`, mediaBinding: { mode: 'paired_av' },
          async startTurn(turn) {
            this.turn = turn
            this.frames = setInterval(() => {
              const data = Buffer.alloc(320 * 240 * 3 / 2, 128)
              data.fill(90, 0, 320 * 240)
              this.emit('media', { type: 'media.video', turn, width: 320, height: 240, data })
            }, 40)
          },
          async appendAudio(input) { this.emit('media', { type: 'media.audio', turn: this.turn, audio: input.data, sampleRate: 24000 }) },
          async appendText() {},
          async finishTurn() { await new Promise(resolve => setTimeout(resolve, 250)); clearInterval(this.frames) },
          async interruptTurn() { clearInterval(this.frames) },
          async close() { clearInterval(this.frames); this.closed = true },
        })
        sessions.push(session)
        return session
      } }),
    }
    const h = await rtcHarness(t, { realMedia: true, digitalHuman, webApp: true })
    const { chromium } = await import('playwright')
    const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
    t.after(() => browser.close())
    const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: desktop ? 480 : 900, height: 720 }, extraHTTPHeaders: { Authorization: 'Bearer test-only-credential' } })
    await context.grantPermissions(['microphone'], { origin: h.base })
    await context.addInitScript(() => {
      window.peers = []
      window.RTCPeerConnection = new Proxy(window.RTCPeerConnection, { construct(Target, args) {
        const peer = new Target(...args); window.peers.push(peer); return peer
      } })
    })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${h.base}/?lang=zh-CN${desktop ? '&desktop=orb&surface=panel' : ''}`)
    const choice = page.getByRole('combobox', { name: '对话形象' })
    await choice.selectOption('test-avatar')
    await page.getByText('数字人已就绪', { exact: true }).waitFor()
    await waitUntil(() => h.frontends.at(-1)?.ready)
    assert.equal(h.frontends.filter(frontend => frontend.ready).length, 1)
    const frontend = h.frontends.at(-1)
    await page.locator('.multimodal-composer textarea').fill('统一会话测试')
    await page.locator('.composer-send').click()
    await waitUntil(() => frontend.inputs.length === 1)
    const responseId = 'avatar-response'
    const pcm = Buffer.alloc(24000 * 2)
    for (let i = 0; i < 24000; i++) pcm.writeInt16LE(Math.round(6000 * Math.sin(i * 2 * Math.PI * 440 / 24000)), i * 2)
    frontend.emit({ type: 'response.created', response: { id: responseId }, __voiceContext: frontend.inputs[0].context })
    frontend.emit({ type: 'response.audio.delta', response_id: responseId, delta: pcm.toString('base64') })
    frontend.emit({ type: 'response.audio_transcript.done', response_id: responseId, transcript: '这是主界面的数字人回复' })
    frontend.emit({ type: 'response.done', response: { id: responseId, status: 'completed' } })
    await page.waitForFunction(() => document.querySelector('.digital-human-video')?.videoWidth === 320)
    await page.waitForFunction(async () => {
      const stats = [...(await window.peers.at(-1).getStats()).values()]
      return stats.some(item => item.type === 'inbound-rtp' && item.kind === 'audio' && item.totalAudioEnergy > 0)
        && stats.some(item => item.type === 'inbound-rtp' && item.kind === 'video' && item.framesDecoded > 0)
    })
    await page.getByText('这是主界面的数字人回复', { exact: true }).waitFor()
    const composer = await page.locator('.multimodal-composer').boundingBox()
    assert.ok(composer.y + composer.height <= 720, 'composer stays inside the viewport')
    sessions.at(-1).emit('provider.error', new Error('synthetic bridge failure'))
    await page.locator('.digital-human-controls').getByText('已降级为语音', { exact: true }).waitFor()
    await choice.selectOption('')
    await waitUntil(() => h.ingress.status().connections === 0)
    await waitUntil(() => h.frontends.at(-1)?.ready && h.frontends.at(-1) !== frontend)
    assert.equal(h.frontends.filter(item => item.ready).length, 1)
    await page.getByText('统一会话测试', { exact: true }).waitFor()
    assert.ok(h.frontends.at(-1).agentContext.recentMessages.some(item => item.content === '统一会话测试'))
    assert.equal(sessions.at(-1).closed, true)
    await choice.selectOption('test-avatar')
    await page.getByText('数字人已就绪', { exact: true }).waitFor()
    h.media.at(-1).child.kill('SIGKILL')
    await page.locator('.digital-human-controls').getByText('已降级为语音', { exact: true }).waitFor()
    await waitUntil(() => h.frontends.at(-1)?.ready && h.ingress.status().connections === 0)
    assert.equal(h.frontends.filter(item => item.ready).length, 1)
    assert.deepEqual(errors, [])
  })
}
