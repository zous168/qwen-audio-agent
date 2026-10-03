import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadConfiguredViduDigitalHuman } from '../src/voice/digital-human/vidu-runtime.mjs'

const validEnvironment = bridgeModule => ({
  VIDU_API_KEY: 'vda_test',
  VIDU_AVATAR_IMAGE_URI: 'https://example.com/avatar.png',
  VIDU_RTC_PROVIDER: 'agora',
  VIDU_RTC_CHANNEL_ID: 'channel',
  VIDU_RTC_USER_ID: 'gateway',
  VIDU_RTC_TOKEN: 'token',
  VIDU_RTC_BRIDGE_MODULE: bridgeModule,
})

test('main Gateway leaves Vidu disabled when no Vidu settings are present', async () => {
  const environment = {}
  const result = await loadConfiguredViduDigitalHuman({ environment, logger: null })
  assert.equal(result.available, false)
  assert.equal(environment.QWAUDIO_WEBRTC_ENABLED, undefined)
})

test('main Gateway keeps audio-only mode when a Vidu key has no RTC bridge', async () => {
  const warnings = []
  const result = await loadConfiguredViduDigitalHuman({
    environment: { VIDU_API_KEY: 'vda_test' },
    logger: { warn: message => warnings.push(message) },
  })
  assert.equal(result.available, false)
  assert.equal(warnings.length, 1)
})

test('main Gateway keeps audio-only mode when a bridge has no Vidu key', async () => {
  const warnings = []
  const result = await loadConfiguredViduDigitalHuman({
    environment: { VIDU_RTC_BRIDGE_MODULE: 'bridge.mjs' },
    logger: { warn: message => warnings.push(message) },
  })
  assert.equal(result.available, false)
  assert.equal(warnings.length, 1)
})

test('invalid optional Vidu configuration leaves the Gateway available in audio mode', async () => {
  const environment = validEnvironment('missing-rtc-bridge.mjs')
  const result = await loadConfiguredViduDigitalHuman({ environment, logger: null })
  assert.equal(result.available, false)
  assert.equal(result.reason, 'invalid_configuration')
  assert.equal(environment.QWAUDIO_WEBRTC_ENABLED, undefined)
})

test('main Gateway assembles Vidu and enables WebRTC through the configured bridge', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'qwa-vidu-runtime-'))
  const bridge = join(directory, 'bridge.mjs')
  writeFileSync(bridge, 'export function openViduRtcBridge() { return { close() {} } }\n')
  const environment = validEnvironment(bridge)
  const infos = []
  try {
    const result = await loadConfiguredViduDigitalHuman({
      environment,
      cwd: directory,
      logger: { info: message => infos.push(message) },
      requireRtc: () => ({ version: 1 }),
    })
    assert.equal(result.available, true)
    assert.deepEqual(result.personas(), [{ id: 'default', label: 'Vidu Avatar' }])
    assert.equal(environment.QWAUDIO_WEBRTC_ENABLED, '1')
    assert.equal(infos.length, 1)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
