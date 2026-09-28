import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionHeader, normalizeSessionEvent } from '../../shared/session-events.mjs'
import { listConversationSessions } from '../src/app/conversation-session-list.mjs'

function journal(ownerId, sessionId, title, content, time) {
  const header = createSessionHeader({ ownerId, sessionId, createdAt: '2026-09-01T00:00:00.000Z' })
  const records = [
    header,
    normalizeSessionEvent({ type: 'session/start', payload: { title } }, { sessionId, seq: 1, time }),
    ...(content ? [normalizeSessionEvent({ type: 'user/message', payload: { content } }, {
      sessionId, seq: 2, time,
    })] : []),
  ]
  return { records }
}

test('lists only the owner’s durable conversations, newest first', () => {
  const entries = [
    journal('owner-a', 'older', '', '问天气', '2026-09-01T01:00:00.000Z'),
    journal('owner-b', 'private', '秘密', '不能显示', '2026-09-01T03:00:00.000Z'),
    journal('owner-a', 'newer', '项目讨论', '', '2026-09-01T02:00:00.000Z'),
  ]
  const listed = listConversationSessions({ *iterateSync() { yield* entries } }, 'owner-a')
  assert.deepEqual(listed.map(item => [item.sessionId, item.title, item.messageCount]), [
    ['newer', '项目讨论', 0], ['older', '问天气', 1],
  ])
})
