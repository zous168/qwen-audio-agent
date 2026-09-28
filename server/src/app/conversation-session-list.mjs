import { replaySession } from '../session/session-replay.mjs'

/** Owner-scoped, bounded summaries for the conversation picker. */
export function listConversationSessions(journals, ownerId, { limit = 100 } = {}) {
  if (!ownerId || typeof journals?.iterateSync !== 'function') return []
  const sessions = []
  for (const entry of journals.iterateSync()) {
    try {
      const replay = replaySession(entry.records)
      if (replay.header.ownerId !== ownerId) continue
      const titleEvent = entry.records.find(record => record.type === 'session/start' && record.payload?.title)
      const firstUser = replay.messages.find(message => message.role === 'user' && message.content)
      const title = String(titleEvent?.payload?.title || firstUser?.content || '新会话')
        .replace(/\s+/gu, ' ').trim().slice(0, 80)
      sessions.push({
        sessionId: replay.header.sessionId,
        title,
        createdAt: replay.header.createdAt,
        updatedAt: entry.records.at(-1)?.time || replay.header.createdAt,
        messageCount: replay.messages.length,
      })
    } catch { /* Invalid journals are already reported by the registry. */ }
  }
  return sessions.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, limit)
}
