import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { gatewayFetch } from './gateway-transport.js'

const displayTitle = value => String(value || '新会话').split('\n')[0].slice(0, 100)

export function SessionAgentPanel({ sessionId, openRequest = 0, requestedView = 'create', showLauncher = true }) {
  const [catalog, setCatalog] = useState({ agents: [], sessions: [], conversations: [] })
  const [open, setOpen] = useState(false)
  const [view, setView] = useState('sessions')
  const [agentFilter, setAgentFilter] = useState('all')
  const [nativeSessions, setNativeSessions] = useState([])
  const [nativeLoading, setNativeLoading] = useState(false)
  const [nativeQuery, setNativeQuery] = useState('')
  const [nativeRefresh, setNativeRefresh] = useState(0)
  const [protocol, setProtocol] = useState('')
  const [workspace, setWorkspace] = useState('')
  const [title, setTitle] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [linkingSessionId, setLinkingSessionId] = useState('')
  const initialized = useRef(false)
  const codexAvailable = catalog.agents.some(item => item.protocol === 'codex')
  useEffect(() => {
    if (openRequest) { setView(requestedView); setOpen(true) }
  }, [openRequest, requestedView])
  useEffect(() => {
    let active = true
    gatewayFetch('api/agent-sessions').then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '无法加载会话设置')
      return data
    }).then(data => {
      if (!active) return
      setCatalog(data)
      if (!initialized.current) {
        const binding = data.sessions?.find(item => item.sessionId === sessionId)
        const first = data.agents?.find(item => item.protocol === binding?.protocol) || data.agents?.[0]
        if (first) {
          setProtocol(first.protocol)
          setWorkspace(binding?.workspace || first.workspace)
          initialized.current = true
        }
      }
    }).catch(error => { if (active) setError(error.message) })
    return () => { active = false }
  }, [sessionId, open])
  useEffect(() => {
    if (!open || view === 'create' || !codexAvailable) return
    let active = true
    setNativeLoading(true); setError('')
    gatewayFetch('api/codex-sessions').then(async response => {
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '无法加载 Codex 会话')
      if (active) setNativeSessions(data.sessions || [])
    }).catch(error => { if (active) setError(error.message) })
      .finally(() => { if (active) setNativeLoading(false) })
    return () => { active = false }
  }, [open, view, nativeRefresh, codexAvailable])
  const link = async nativeSessionId => {
    if (saving) return
    setLinkingSessionId(nativeSessionId)
    setSaving(true); setError('')
    try {
      const response = await gatewayFetch('api/agent-sessions/link-codex', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: crypto.randomUUID(), nativeSessionId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '关联失败')
      selectSession(data.sessionId)
    } catch (error) { setError(error.message) }
    finally { setSaving(false); setLinkingSessionId('') }
  }
  const selectSession = id => {
    if (id === sessionId) { setOpen(false); return }
    const url = new URL(window.location.href)
    url.searchParams.set('session', id)
    window.location.assign(url.toString())
  }
  const create = async () => {
    setSaving(true); setError('')
    try {
      const next = protocol ? crypto.randomUUID() : null
      const response = await gatewayFetch(protocol ? 'api/agent-sessions' : 'api/conversations', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(protocol ? { sessionId: next, protocol, workspace, title } : { title }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '创建失败')
      selectSession(data.sessionId)
    } catch (error) { setError(error.message); setSaving(false) }
  }
  const nativeList = <div>
          <p>沿用已有 Codex 会话的上下文和项目目录。网页显示关联之后的新消息。请在原会话停止执行后再从这里继续。</p>
          <label>搜索会话 <input aria-label="搜索 Codex 会话" value={nativeQuery} onChange={event => setNativeQuery(event.target.value)} placeholder="标题、项目目录或会话 ID" /></label>
          <button onClick={() => setNativeRefresh(value => value + 1)} disabled={nativeLoading || saving}>刷新列表</button>
          {nativeLoading && <p role="status">正在加载 Codex 会话…</p>}
          {error && <p role="alert">{error}</p>}
          {!nativeLoading && !nativeSessions.length && !error && <p>未发现本机已有 Codex 会话。</p>}
          <div style={{ display: 'grid', gap: 10, marginTop: 16 }}>
            {nativeSessions.filter(item => [item.title, item.workspace, item.sessionId].join(' ').toLowerCase().includes(nativeQuery.toLowerCase())).slice(0, 50).map(item => <button className="session-agent-item" key={item.sessionId} disabled={saving} onClick={() => link(item.sessionId)}>
              <span className="session-agent-switch">{linkingSessionId === item.sessionId ? '正在关联…' : '关联并切换'}</span>
              {displayTitle(item.title)}<small style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.workspace} · {item.sessionId}</small>
            </button>)}
          </div>
  </div>
  const bindings = new Map((catalog.sessions || []).map(item => [item.sessionId, item]))
  const combined = new Map((catalog.conversations || []).map(item => [item.sessionId, {
    ...item, ...bindings.get(item.sessionId),
  }]))
  for (const item of catalog.sessions || []) if (!combined.has(item.sessionId)) combined.set(item.sessionId, item)
  const filteredSessions = [...combined.values()].filter(item => agentFilter === 'all'
    || (agentFilter === 'default' ? !item.protocol : item.protocol === agentFilter))
  const current = combined.get(sessionId)
  return <>
    {showLauncher && <button className="ghost session-agent-launch" onClick={() => { setView('sessions'); setOpen(true) }}>{catalog.agents.length ? '会话与 Agent' : '会话'}</button>}
    {open && createPortal(<div className="session-agent-overlay" role="dialog" aria-modal="true" aria-label="会话" onKeyDown={event => { if (event.key === 'Escape') setOpen(false) }}>
      <div className="session-agent-dialog">
        <button className="ghost" onClick={() => setOpen(false)}>关闭</button>
        <h2>会话</h2>
        <p>选择已有会话继续对话，或新建会话。新会话可以沿用当前后台 Agent，也可以固定绑定 Agent 和项目。</p>
        {current && <p className="session-agent-current">当前会话：{displayTitle(current.title)}{current.protocol ? ` · ${current.protocol}` : ''}<small>{current.workspace}</small></p>}
        <div className="session-agent-tabs" role="tablist" aria-label="会话管理">
          <button role="tab" aria-selected={view === 'sessions'} onClick={() => setView('sessions')}>切换会话</button>
          <button role="tab" aria-selected={view === 'create'} onClick={() => setView('create')}>新建会话</button>
          {catalog.agents.some(item => item.protocol === 'codex') && <button role="tab" aria-selected={view === 'link'} onClick={() => setView('link')}>关联已有 Codex 会话</button>}
        </div>
        {view === 'link' && <section role="tabpanel" aria-label="关联已有 Codex 会话">{nativeList}</section>}
        {view === 'create' && <section role="tabpanel" aria-label="新建会话">
        <h3>新建会话设置</h3>
        <div style={{ display: 'grid', gap: 12 }}>
          <label>Agent <select aria-label="会话 Agent" value={protocol} onChange={event => {
            setProtocol(event.target.value)
            setWorkspace(catalog.agents.find(item => item.protocol === event.target.value)?.workspace || '')
          }}><option value="">沿用当前后台 Agent</option>{catalog.agents.map(item => <option key={item.protocol} value={item.protocol}>{item.label}</option>)}</select></label>
          <label>会话名称 <input aria-label="会话名称" value={title} onChange={event => setTitle(event.target.value)} /></label>
          {protocol && <label>项目目录 <input aria-label="项目目录" style={{ width: '100%' }} value={workspace} onChange={event => setWorkspace(event.target.value)} /></label>}
          {protocol === 'cursor' && <p>Cursor 需要先在终端运行 agent login。当前安装版本只在服务运行期间保留 Agent 上下文；服务重启后会创建新的原生会话。</p>}
          {error && <p role="alert">{error}</p>}
          <button className="ghost" disabled={saving || (protocol && !workspace)} onClick={create}>{saving ? '正在创建…' : '创建并进入'}</button>
        </div>
        </section>}
        {view === 'sessions' && <section role="tabpanel" aria-label="切换会话">
        <h3>选择要继续的会话</h3>
        <label>Agent 类型筛选
          <select aria-label="Agent 类型筛选" value={agentFilter} onChange={event => setAgentFilter(event.target.value)}>
            <option value="all">全部 Agent</option>
            <option value="default">沿用当前后台 Agent</option>
            {catalog.agents.map(item => <option key={item.protocol} value={item.protocol}>{item.label}</option>)}
          </select>
        </label>
        {(agentFilter === 'all' || agentFilter === 'codex') && catalog.agents.some(item => item.protocol === 'codex') && <>
          <h3>Codex 已有会话</h3>
          {nativeList}
        </>}
        <h3>语音会话</h3>
        {!filteredSessions.length && <p role="status">暂无该 Agent 类型的语音会话。可在「新建会话」中创建。</p>}
        <div style={{ display: 'grid', gap: 10 }}>
          {filteredSessions.map(item => <button className="ghost session-agent-item" key={item.sessionId} aria-current={item.sessionId === sessionId ? 'true' : undefined} onClick={() => selectSession(item.sessionId)} style={{ textAlign: 'left', padding: 14 }}>
            <span className="session-agent-switch">{item.sessionId === sessionId ? '当前会话' : '切换'}</span>
            {displayTitle(item.title)}{item.protocol ? ` · ${item.protocol}` : ''}{item.nativeSessionId ? ' · 已关联' : ''}
            <small style={{ display: 'block', overflowWrap: 'anywhere' }}>{item.workspace ? `${item.workspace} · ` : ''}{item.sessionId.slice(0, 8)}</small>
          </button>)}
        </div>
        </section>}
      </div>
    </div>, document.body)}
  </>
}
