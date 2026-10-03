import { useCallback, useEffect, useState } from 'react'
import { gatewayFetch, gatewayTransportConfig } from '../gateway-transport.js'

export default function useDigitalHuman() {
  const key = `qwaudio.avatar:${gatewayTransportConfig().gatewayUrl || location.origin}`
  const [selected, setSelected] = useState(() => {
    try { return localStorage.getItem(key) || '' } catch { return '' }
  })
  const [capability, setCapability] = useState({ available: false, personas: [], reason: 'loading' })
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    let timer
    const refresh = async () => {
      try {
        const response = await gatewayFetch('/api/digital-human', { cache: 'no-store', signal: abort.signal })
        if (!response.ok) throw new Error('unavailable')
        const result = await response.json()
        if (!abort.signal.aborted) setCapability({ ...result, personas: Array.isArray(result.personas) ? result.personas : [] })
      } catch {
        if (!abort.signal.aborted) setCapability(previous => ({ ...previous, reason: 'unreachable' }))
      } finally {
        if (!abort.signal.aborted) timer = setTimeout(refresh, 30000)
      }
    }
    void refresh()
    return () => { abort.abort(); clearTimeout(timer) }
  }, [revision])
  const select = useCallback(id => {
    setSelected(id)
    try { localStorage.setItem(key, id) } catch { /* Storage can be disabled. */ }
  }, [key])
  const personaId = capability.available && capability.personas.some(persona => persona.id === selected) ? selected : ''
  return { ...capability, personaId, select, refresh: () => setRevision(value => value + 1) }
}
