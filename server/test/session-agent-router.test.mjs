import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionAgentRouter } from '../src/backend/session-agent-router.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'session-agents-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const created = []
  const tasks = new Map()
  const client = protocol => ({
    protocol, label: protocol, describe: () => ({ protocol }),
    health: async () => ({ ok: true }), start: async () => {},
    status: () => ({ ok: true }), submit: async work => work,
    cancel: async id => id, respondAuthorization: async (...args) => args,
    respondInput: async (...args) => args, subscribe: () => () => {}, close: async () => {},
  })
  const options = {
    fallback: client('hermes'), protocols: ['hermes', 'codex', 'cursor'],
    backends: Object.fromEntries(['hermes', 'codex', 'cursor'].map(id => [id, { directory }])),
    stateDirectory: directory, taskLookup: id => tasks.get(id),
    createClient: options => { const result = client(options.protocol); created.push({ options, result }); return result },
  }
  return { router: new SessionAgentRouter(options), options, created, directory, tasks }
}

test('isolates conversations and owners, persists immutable bindings across restart', t => {
  const { router, options, created } = fixture(t)
  const a = { ownerId: 'alice', sessionId: 'one' }
  const b = { ownerId: 'alice', sessionId: 'two' }
  router.bind({ ...a, protocol: 'codex' })
  router.bind({ ...b, protocol: 'cursor' })
  assert.equal(router.forSession(a).protocol, 'codex')
  assert.equal(router.forSession(b).protocol, 'cursor')
  assert.equal(router.forSession(a), router.forSession(a))
  assert.notEqual(created[0].options.sessionStatePath, created[1].options.sessionStatePath)
  assert.equal(router.forSession({ ownerId: 'bob', sessionId: 'one' }).protocol, 'hermes')
  assert.equal(router.list('alice').length, 2)
  assert.equal(router.list('bob').length, 1)
  assert.throws(() => router.bind({ ...a, protocol: 'hermes' }), /固定绑定/)
  const restarted = new SessionAgentRouter(options)
  assert.equal(restarted.forSession(a).protocol, 'codex')
  assert.equal(created[0].options.sessionStatePath, created[3].options.sessionStatePath)
})

test('starts with session choices when the fallback Agent is not configured', t => {
  const { options } = fixture(t)
  options.fallback = {
    ...options.fallback,
    enabled: false,
    protocol: null,
    subscribe: () => { throw new Error('No fallback Agent is configured') },
  }
  const router = new SessionAgentRouter(options)
  assert.equal(router.choices().length, 3)
  assert.equal(router.forSession({ ownerId: 'alice', sessionId: 'new' }), options.fallback)
})

test('routes cancellation and approvals by task binding and rejects another owner', async t => {
  const { router, created, tasks } = fixture(t)
  const work = { id: 'task-1', ownerId: 'alice', sessionId: 'one' }
  router.bind({ ...work, protocol: 'cursor' })
  await router.submit(work)
  assert.equal(created.length, 1)
  assert.equal(await router.cancel(work.id, { ownerId: 'alice' }), work.id)
  assert.deepEqual((await router.respondAuthorization(work.id, 'permission', 'allow', { ownerId: 'alice' })).slice(0, 3), [work.id, 'permission', 'allow'])
  assert.throws(() => router.cancel(work.id, { ownerId: 'bob' }), /不属于/)
  tasks.set('persisted', { ownerId: 'alice', sessionId: 'one' })
  assert.equal(await router.cancel('persisted', { ownerId: 'alice' }), 'persisted')
})

test('does not accept an unknown agent or a non-directory workspace', t => {
  const { router } = fixture(t)
  assert.throws(() => router.bind({ ownerId: 'alice', sessionId: 'one', protocol: 'unknown' }), /无效/)
  assert.throws(() => router.bind({ ownerId: 'alice', sessionId: 'one', protocol: 'hermes', workspace: 'relative' }), /绝对路径/)
})

test('keeps legacy tasks on the fallback and uses native permissions for Cursor', async t => {
  const { router, tasks, created, options } = fixture(t)
  tasks.set('legacy', { ownerId: 'alice' })
  assert.equal(router.forSession({ ownerId: 'alice' }), options.fallback)
  assert.equal(await router.cancel('legacy', { ownerId: 'alice' }), 'legacy')
  router.bind({ ownerId: 'alice', sessionId: 'cursor', protocol: 'cursor' })
  router.forSession({ ownerId: 'alice', sessionId: 'cursor' })
  assert.equal(created[0].options.permissionMode, 'native')
})

test('links only discovered sessions, persists native ID and reuses an existing binding', async t => {
  const { router, directory, created, options } = fixture(t)
  let fail = false
  router.validateNativeSession = async () => { if (fail) throw new Error('resume failed') }
  router.nativeClient = () => ({
    listNativeSessions: async () => [{sessionId:'native-one',cwd:directory,title:'Existing Codex'}],
    validateNativeSession: async () => { if (fail) throw new Error('resume failed') },
  })
  await assert.rejects(router.linkNativeSession({ownerId:'alice',sessionId:'bad',nativeSessionId:'unknown'}), /找不到/)
  fail = true
  await assert.rejects(router.linkNativeSession({ownerId:'alice',sessionId:'failed',nativeSessionId:'native-one'}), /resume failed/)
  assert.equal(router.list('alice').length, 0)
  fail = false
  const binding = await router.linkNativeSession({ownerId:'alice',sessionId:'linked',nativeSessionId:'native-one'})
  assert.equal(binding.nativeSessionId, 'native-one')
  assert.equal((await router.linkNativeSession({ownerId:'alice',sessionId:'another',nativeSessionId:'native-one'})).sessionId, 'linked')
  await assert.rejects(router.linkNativeSession({ownerId:'bob',sessionId:'other',nativeSessionId:'native-one'}), /其他用户/)
  const restarted = new SessionAgentRouter(options)
  restarted.forSession({ownerId:'alice',sessionId:'linked'})
  assert.deepEqual(created.at(-1).options.linkedSession, {ownerId:'alice',sessionId:'native-one'})
  assert.throws(() => restarted.bind({...binding,nativeSessionId:'different'}), /固定绑定/)
})


test('validation releases its client on success and failure', async t => {
  const { router } = fixture(t)
  let closed = 0
  let fail = false
  router.createClient = () => ({
    validateNativeSession: async () => { if (fail) throw new Error('occupied') },
    close: async () => { closed++ },
  })
  await router.validateNativeSession('native', '/project')
  fail = true
  await assert.rejects(router.validateNativeSession('native', '/project'), /occupied/)
  assert.equal(closed, 2)
})

test('reports active writer conflicts without persisting a binding', async t => {
  const { router, directory } = fixture(t)
  router.nativeClient = () => ({listNativeSessions: async () => [{sessionId:'busy',cwd:directory}]})
  router.validateNativeSession = async () => { throw new Error('Internal error: thread busy already has an active writer') }
  await assert.rejects(router.linkNativeSession({ownerId:'alice',sessionId:'new',nativeSessionId:'busy'}), error => error.code === 'native_session_busy' && /占用/.test(error.message))
  assert.equal(router.list('alice').length, 0)
})
