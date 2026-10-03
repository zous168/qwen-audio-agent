import test from 'node:test'
import assert from 'node:assert/strict'
import { createGatewaySessionHello, GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES } from '../../shared/protocol/gateway-client-protocol.mjs'
import { rtcHarness, waitUntil } from './fixtures/webrtc-gateway.mjs'
import { GatewayClientCommandRuntime } from '../src/client/client-command-runtime.mjs'

test('GCP over RTC negotiates desktop capabilities and correlates history/tasks on one session', async t => {
  const h = await rtcHarness(t, { clientCommandRuntime: new GatewayClientCommandRuntime({ taskManager: {}, taskOperations: { list: () => [] }, conversationHistory: { messages: () => [] } }) })
  const response = await h.offer(undefined, '?protocol=gateway&sessionId=shared-session')
  assert.equal(response.status, 200)
  const media = h.media[0]
  media.onOpen()
  assert.equal(h.frontends.length, 0, 'RTC must await the shared client hello')
  const hello = createGatewaySessionHello({ clientType: 'desktop', clientLabel: 'Desktop', clientInstanceId: 'shared-desktop', capabilities: GATEWAY_CLIENT_IMPLEMENTED_CAPABILITIES, connection: { input_enabled: true, output_enabled: true, voice_enabled: true, client_states: ['sleeping'] } })
  media.onEvent(JSON.stringify(hello))
  await waitUntil(() => media.events.some(event => event.type === 'session.ready'))
  const ready = media.events.find(event => event.type === 'session.ready')
  assert.ok(ready.capabilities.includes('client.presence'))
  await waitUntil(() => h.frontends[0]?.ready)
  media.onEvent(JSON.stringify({ type: 'conversation.history', event_id: 'history-1' }))
  media.onEvent(JSON.stringify({ type: 'task.list', event_id: 'tasks-1' }))
  await waitUntil(() => media.events.some(event => event.request_event_id === 'tasks-1'))
  const history = media.events.find(event => event.request_event_id === 'history-1')
  assert.equal(history.type, 'conversation.history.result', JSON.stringify(history))
  assert.equal(media.events.find(event => event.request_event_id === 'tasks-1').type, 'task.list.result')
  media.onEvent(JSON.stringify({ type: 'input.message', event_id: 'message-1', parts: [{ type: 'text', text: 'Shared conversation' }] }))
  await waitUntil(() => h.frontends[0].inputs.length === 1)
  assert.equal(h.frontends.length, 1)
})

test('capability discovery works while RTC is disabled and strips private persona fields', async t => {
  const h = await rtcHarness(t, { digitalHuman: { available: true, personas: () => [{ id: 'avatar', label: 'Avatar', token: 'never-public', avatar: { uri: 'private' } }] } })
  const result = await (await fetch(h.base + '/api/digital-human', { headers: h.headers })).json()
  assert.deepEqual(result.personas, [{ id: 'avatar', label: 'Avatar' }])
  assert.equal((await fetch(h.base + '/api/digital-human')).status, 401)
  const disabled = await rtcHarness(t, { options: { enabled: false } })
  const payload = await (await fetch(disabled.base + '/api/digital-human', { headers: disabled.headers })).json()
  assert.equal(payload.available, false)
  assert.equal(payload.reason, 'not_configured')
})
