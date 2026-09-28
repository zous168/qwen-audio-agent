import { createHash } from 'node:crypto'
import { resolve, isAbsolute } from 'node:path'
import { statSync } from 'node:fs'
import { VersionedJsonStore } from '../core/versioned-json-store.mjs'
import { normalizeConversationSessionId } from '../../../shared/conversation-session.mjs'
import { BackendAvailability } from './availability.mjs'

const labels = { hermes: 'Hermes', codex: 'Codex', cursor: 'Cursor' }
const keyFor = (ownerId, sessionId) => JSON.stringify([ownerId, sessionId])

/** Owns one adapter and persistent native session index per conversation. */
export class SessionAgentRouter {
  constructor({ fallback, protocols, backends, stateDirectory, createClient, taskLookup }) {
    this.fallback = fallback
    this.protocols = protocols.filter(protocol => labels[protocol])
    this.backends = backends
    this.stateDirectory = stateDirectory
    this.createClient = createClient
    this.taskLookup = taskLookup
    this.clients = new Map()
    this.availability = new Map()
    this.listeners = new Set()
    this.unsubscribeFallback = fallback.enabled
      ? fallback.subscribe(event => {
          for (const listener of this.listeners) listener(event)
        })
      : null
    this.taskRoutes = new Map()
    this.store = new VersionedJsonStore({
      filePath: resolve(stateDirectory, 'session-agent-bindings.json'),
      version: 1, label: '会话 Agent 绑定',
    })
    const data = this.store.load({
      fallback: () => ({ bindings: [] }),
      validate: data => Array.isArray(data.bindings) && data.bindings.every(item =>
        typeof item.ownerId === 'string' && normalizeConversationSessionId(item.sessionId)
        && labels[item.protocol] && typeof item.workspace === 'string'),
    })
    this.bindings = new Map(data.bindings.map(item => [keyFor(item.ownerId, item.sessionId), item]))
  }

  get enabled() { return true }
  get protocol() { return this.fallback.protocol }
  get label() { return this.fallback.label }
  choices() {
    return this.protocols.map(protocol => ({ protocol, label: labels[protocol], workspace: this.backends[protocol]?.directory || '' }))
  }
  list(ownerId) {
    return [...this.bindings.values()].filter(item => item.ownerId === ownerId)
      .sort((a, b) => b.createdAt - a.createdAt).map(item => ({ ...item }))
  }
  nativeClient() {
    if (!this.protocols.includes('codex')) throw new Error('未配置 Codex')
    if (!this.discoveryClient) this.discoveryClient = this.createClient({ protocol: 'codex', sessionStatePath: resolve(this.stateDirectory, 'codex-discovery.json') })
    return this.discoveryClient
  }
  async listNativeSessions() {
    return (await this.nativeClient().listNativeSessions()).map(item => ({
      sessionId: item.sessionId, title: String(item.title || 'Codex 会话').split('\n')[0].slice(0, 100), workspace: item.cwd, updatedAt: item.updatedAt,
    }))
  }
  async validateNativeSession(nativeSessionId, workspace) {
    // A resume acquires a writer. Never leave validation sessions loaded in
    // the long-lived discovery process before the conversation client resumes.
    const probe = this.createClient({ protocol: 'codex', sessionStatePath: null })
    try { await probe.validateNativeSession(nativeSessionId, workspace) }
    finally { await probe.close() }
  }
  async linkNativeSession({ ownerId, sessionId, nativeSessionId }) {
    if (!ownerId || !normalizeConversationSessionId(sessionId) || !nativeSessionId) throw new Error('无效的关联会话')
    const existing = [...this.bindings.values()].find(item => item.protocol === 'codex' && item.nativeSessionId === nativeSessionId)
    if (existing) {
      if (existing.ownerId !== ownerId) throw new Error('该 Codex 会话已被其他用户关联')
      return { ...existing }
    }
    const native = (await this.listNativeSessions()).find(item => item.sessionId === nativeSessionId)
    if (!native) throw new Error('找不到该 Codex 会话，请刷新列表')
    try {
      await this.validateNativeSession(native.sessionId, native.workspace)
    } catch (error) {
      if (/already has an active writer/i.test(error.message)) {
        const busy = new Error('该 Codex 会话正被桌面端或其他客户端占用，暂时无法关联。请先停止原会话任务，并由原客户端释放该会话后重试；也可以选择其他会话。')
        busy.code = 'native_session_busy'
        throw busy
      }
      throw error
    }
    return this.bind({ ownerId, sessionId, protocol: 'codex', workspace: native.workspace, title: native.title, nativeSessionId })
  }
  bind({ ownerId, sessionId, protocol, workspace, title = '', nativeSessionId = '' }) {
    sessionId = normalizeConversationSessionId(sessionId)
    if (!ownerId || !sessionId || !this.protocols.includes(protocol)) throw new Error('无效的会话或 Agent')
    const key = keyFor(ownerId, sessionId)
    const previous = this.bindings.get(key)
    workspace ||= this.backends[protocol]?.directory
    if (!workspace || !isAbsolute(workspace) || !statSync(workspace).isDirectory()) throw new Error('工作目录必须是已有的绝对路径')
    workspace = resolve(workspace)
    if (previous) {
      if (previous.protocol !== protocol || previous.workspace !== workspace || (previous.nativeSessionId || '') !== nativeSessionId) throw new Error('会话已固定绑定；更换 Agent 或项目请新建会话')
      return { ...previous }
    }
    const binding = { ownerId, sessionId, protocol, workspace, title: String(title).trim().slice(0, 120) || labels[protocol], createdAt: Date.now(), ...(nativeSessionId ? { nativeSessionId } : {}) }
    this.bindings.set(key, binding)
    if (!this.store.save({ bindings: [...this.bindings.values()] })) {
      this.bindings.delete(key)
      throw new Error('无法保存会话绑定')
    }
    return { ...binding }
  }
  binding(context) {
    const existing = this.bindings.get(keyFor(context.ownerId, context.sessionId))
    if (existing) return existing
    if (!this.protocols.includes(this.fallback.protocol)) return null
    return this.bind({ ...context, protocol: this.fallback.protocol })
  }
  forSession(context) {
    if (!context?.sessionId) return this.fallback
    const binding = this.binding(context)
    if (!binding) return this.fallback
    const key = keyFor(binding.ownerId, binding.sessionId)
    if (!this.clients.has(key)) {
      const index = createHash('sha256').update(key).digest('hex')
      const client = this.createClient({
        protocol: binding.protocol,
        ...(binding.nativeSessionId ? { linkedSession: { sessionId: binding.nativeSessionId, ownerId: binding.ownerId } } : {}),
        ...(binding.protocol === 'cursor' ? { permissionMode: 'native' } : {}),
        backends: { [binding.protocol]: { ...this.backends[binding.protocol], directory: binding.workspace } },
        sessionStatePath: resolve(this.stateDirectory, 'session-agents', `${index}.json`),
      })
      client.subscribe(event => {
        for (const listener of this.listeners) listener({ ...event, sessionId: binding.sessionId })
      })
      this.clients.set(key, client)
    }
    return this.clients.get(key)
  }
  availabilityFor(context) {
    const key = keyFor(context.ownerId, context.sessionId)
    if (!this.availability.has(key)) {
      const cache = new BackendAvailability({ probe: async () => {
        const health = await this.forSession(context).health()
        return { configured: true, ok: health.ok === true, transient: health.status === 'starting' }
      } })
      this.availability.set(key, cache)
      cache.refresh()
    }
    return this.availability.get(key)
  }
  clientForTask(taskId, options = {}) {
    const task = this.taskRoutes.get(taskId) || this.taskLookup(taskId, options)
    if (!task || !options.ownerId || task.ownerId !== options.ownerId) throw new Error('任务不存在或不属于当前用户')
    return this.forSession(task)
  }
  describe(context) { return context?.sessionId ? this.forSession(context).describe() : this.fallback.describe() }
  health(context) { return context?.sessionId ? this.forSession(context).health() : this.fallback.health() }
  start(options) { return this.fallback.start(options) }
  status(taskId, options = {}) {
    if (taskId) return this.clientForTask(taskId, options).status(taskId, options)
    return options.sessionId ? this.forSession(options).status() : this.fallback.status()
  }
  submit(work, options = {}) {
    if (!work.sessionId) return this.fallback.submit(work, options)
    this.taskRoutes.set(work.id, { ownerId: work.ownerId, sessionId: work.sessionId })
    return this.forSession(work).submit(work, options)
  }
  cancel(taskId, options) { return this.clientForTask(taskId, options).cancel(taskId, options) }
  respondAuthorization(taskId, id, decision, options) { return this.clientForTask(taskId, options).respondAuthorization(taskId, id, decision, options) }
  respondInput(taskId, id, response, options) { return this.clientForTask(taskId, options).respondInput(taskId, id, response, options) }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  canRecoverDelegatedWork(task) { return this.forSession(task).canRecoverDelegatedWork?.(task) === true }
  recoverDelegatedWork(task, options) { return this.forSession(task).recoverDelegatedWork(task, options) }
  uiUrl(options) { return options?.sessionId ? this.forSession(options).uiUrl(options) : this.fallback.uiUrl(options) }
  async close() {
    this.unsubscribeFallback?.()
    await this.discoveryClient?.close()
    for (const cache of this.availability.values()) cache.close()
    await Promise.allSettled([this.fallback.close(), ...[...this.clients.values()].map(client => client.close())])
    this.clients.clear()
  }
}
