import { describe, it, expect } from 'vitest'
import { inboxItems, itemKey, type InboxTask, type PendingTask } from '../src/domain/inbox.js'

const NOW = Date.parse('2026-11-19T10:00:00Z')
const t = (id: string, waitingOn?: InboxTask['waitingOn']): InboxTask => ({ id, space: 'main', title: id, waitingOn })

describe('the Inbox', () => {
  const tasks = [
    t('asked', { who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T09:00:00Z', session_id: 's1' }),
    t('finished', { who: 'lasse', kind: 'review', why: 'result ready', since: '2026-11-19T08:00:00Z' }),
    t('go', { who: 'lasse', kind: 'go', why: 'ready to send', since: '2026-11-19T07:00:00Z' }),
    t('customer', { who: 'kim', kind: 'outside', since: '2026-11-18T07:00:00Z' }),
    t('stopped', { who: 'lasse', kind: 'stopped', since: '2026-11-18T06:00:00Z' }),
    t('quiet'),
  ]
  const pending: PendingTask[] = [{ id: 'pending-1', space: 'main', title: 'Check the Shopify sync', sessionId: 's9', createdAt: '2026-11-19T09:30:00Z' }]

  it('holds questions, gos, results to review and proposed tasks, newest first', () => {
    const { live } = inboxItems(tasks, pending, 'lasse', [], NOW)
    expect(live.map((i) => [i.kind, i.taskId ?? i.pendingId])).toEqual([
      ['new_task', 'pending-1'],
      ['question', 'asked'],
      ['review', 'finished'],
      ['question', 'go'],
    ])
    expect(live[1]).toMatchObject({ text: 'Which list?', sessionId: 's1', since: '2026-11-19T09:00:00Z' })
  })

  it('a snooze hides an item until its time; a newer question on the same task is a new item', () => {
    const snoozes = [{ key: itemKey({ taskId: 'asked', since: '2026-11-19T09:00:00Z' }), until: '2026-11-20T01:00:00Z' }]
    const hidden = inboxItems(tasks, [], 'lasse', snoozes, NOW)
    expect(hidden.live.map((i) => i.taskId)).not.toContain('asked')
    expect(hidden.snoozed.map((i) => [i.taskId, i.until])).toEqual([['asked', '2026-11-20T01:00:00Z']])

    const later = inboxItems(tasks, [], 'lasse', snoozes, Date.parse('2026-11-20T02:00:00Z'))
    expect(later.live.map((i) => i.taskId)).toContain('asked')

    const newer = [t('asked', { who: 'lasse', kind: 'question', why: 'And the other list?', since: '2026-11-19T09:45:00Z' })]
    expect(inboxItems(newer, [], 'lasse', snoozes, NOW).live.map((i) => i.text)).toEqual(['And the other list?'])
  })

  it('keys a proposed task by its pending id', () => {
    expect(itemKey({ pendingId: 'pending-1' })).toBe('pending:pending-1')
    expect(itemKey({ taskId: 'a', since: 's' })).toBe('task:a@s')
  })
})
