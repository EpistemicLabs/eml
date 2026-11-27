import { describe, it, expect } from 'vitest'
import { inboxItems, itemKey, type InboxTask } from '../src/domain/inbox.js'

const NOW = Date.parse('2026-11-19T10:00:00Z')
type W = Omit<InboxTask['waits'][number], 'id'>
const t = (id: string, ...waits: W[]): InboxTask => ({ id, space: 'main', title: id, waits: waits.map((w, i) => ({ id: w.session_id ?? `w${i}`, ...w })) })

describe('the Inbox', () => {
  const tasks = [
    t('asked', { who: 'lasse', kind: 'question', why: 'Which list?', since: '2026-11-19T09:00:00Z', session_id: 's1' }),
    t('finished', { who: 'lasse', kind: 'review', why: 'result ready', since: '2026-11-19T08:00:00Z' }),
    t('go', { who: 'lasse', kind: 'go', why: 'ready to send', since: '2026-11-19T07:00:00Z' }),
    t('customer', { who: 'kim', kind: 'outside', since: '2026-11-18T07:00:00Z' }),
    t('stopped', { who: 'lasse', kind: 'stopped', why: 'No activity for 1 h', since: '2026-11-18T06:00:00Z', session_id: 's9' }),
    t('quiet'),
  ]
  it('holds questions, gos, results to review and stopped workers, newest first', () => {
    const { live } = inboxItems(tasks, 'lasse', [], NOW)
    expect(live.map((i) => [i.kind, i.taskId])).toEqual([
      ['question', 'asked'],
      ['review', 'finished'],
      ['question', 'go'],
      ['stopped', 'stopped'],
    ])
    expect(live[3]).toMatchObject({ text: 'No activity for 1 h', sessionId: 's9', key: 'task:stopped@2026-11-18T06:00:00Z' })
    expect(live[0]).toMatchObject({ text: 'Which list?', sessionId: 's1', since: '2026-11-19T09:00:00Z' })
  })

  it('leaves out an outside wait that names the viewer: someone outside has the next move', () => {
    const kept = [t('blocker', { who: 'lasse', kind: 'outside', why: 'Waiting for the supplier', since: '2026-11-19T09:00:00Z' })]
    expect(inboxItems(kept, 'lasse', [], NOW)).toEqual({ live: [], snoozed: [] })
  })

  it('a snooze hides an item until its time; a newer question on the same task is a new item', () => {
    const snoozes = [{ key: itemKey({ taskId: 'asked', since: '2026-11-19T09:00:00Z' }), until: '2026-11-20T01:00:00Z' }]
    const hidden = inboxItems(tasks, 'lasse', snoozes, NOW)
    expect(hidden.live.map((i) => i.taskId)).not.toContain('asked')
    expect(hidden.snoozed.map((i) => [i.taskId, i.until])).toEqual([['asked', '2026-11-20T01:00:00Z']])

    const later = inboxItems(tasks, 'lasse', snoozes, Date.parse('2026-11-20T02:00:00Z'))
    expect(later.live.map((i) => i.taskId)).toContain('asked')

    const newer = [t('asked', { who: 'lasse', kind: 'question', why: 'And the other list?', since: '2026-11-19T09:45:00Z' })]
    expect(inboxItems(newer, 'lasse', snoozes, NOW).live.map((i) => i.text)).toEqual(['And the other list?'])
  })

  it('a parked wait is listed as snoozed until its date, on every device; past it, it is live again (v0.23)', () => {
    const parked = t('parked', { who: 'lasse', kind: 'question', why: 'later', since: '2026-11-19T09:00:00Z', snoozed_until: '2026-11-20T00:00:00.000Z' })
    const back = t('back', { who: 'lasse', kind: 'question', why: 'now', since: '2026-11-19T08:00:00Z', snoozed_until: '2026-11-19T00:00:00.000Z' })
    const r = inboxItems([parked, back], 'lasse', [], Date.parse('2026-11-19T10:00:00Z'))
    expect(r.live.map((i) => i.taskId)).toEqual(['back'])
    expect(r.snoozed.map((i) => [i.taskId, i.until])).toEqual([['parked', '2026-11-20T00:00:00.000Z']])
  })

  it('a stopped worker is an item only for the person it waits on, and can be parked like a question', () => {
    const stopped = (patch: Partial<W> = {}) => [t('hung', { who: 'lasse', kind: 'stopped', why: 'No activity for 1 h', since: '2026-11-19T09:00:00Z', session_id: 's1', ...patch })]
    expect(inboxItems(stopped(), 'kim', [], NOW)).toEqual({ live: [], snoozed: [] })
    const parked = inboxItems(stopped({ snoozed_until: '2026-11-20T00:00:00.000Z' }), 'lasse', [], NOW)
    expect(parked.live).toEqual([])
    expect(parked.snoozed.map((i) => [i.kind, i.until])).toEqual([['stopped', '2026-11-20T00:00:00.000Z']])
  })

  it('lists every wait of a task on the viewer as an item of its own, each opening its session', () => {
    const two = [t('both', { who: 'lasse', kind: 'question', why: 'First?', since: '2026-11-19T08:00:00Z', session_id: 'a' }, { who: 'lasse', kind: 'review', why: 'Review: done', since: '2026-11-19T09:00:00Z', session_id: 'b' }, { who: 'kim', kind: 'outside', since: '2026-11-19T09:30:00Z' })]
    expect(inboxItems(two, 'lasse', [], NOW).live.map((i) => [i.kind, i.sessionId])).toEqual([['review', 'b'], ['question', 'a']])
  })

  it('keys an item by its task and the moment its wait began', () => {
    expect(itemKey({ taskId: 'a', since: 's' })).toBe('task:a@s')
  })
})

describe('a step that is the viewer\'s to take (do, "Your move")', () => {
  const withWake = (task: InboxTask, extra: Partial<InboxTask>): InboxTask => ({ ...task, ...extra })
  it('is an item of kind do with the wait\'s id for Done, its due date, the task\'s check-back and whether it repeats', () => {
    const asked = withWake(t('contract', { who: 'dev-user', kind: 'do', why: 'Sign the contract', since: '2026-11-19T09:00:00Z', session_id: 's1', due: '2026-11-20' }),
      { wake: { at: '2026-11-21T09:00:00.000Z', by: 'atlas' } })
    const reminder = withWake(t('bank', { who: 'dev-user', kind: 'do', why: 'Call the bank', since: '2026-11-19T08:00:00Z' }), { repeating: true })
    const { live } = inboxItems([asked, reminder], 'dev-user', [], NOW)
    expect(live).toEqual([
      { key: 'task:contract@2026-11-19T09:00:00Z', kind: 'do', space: 'main', title: 'contract', text: 'Sign the contract', since: '2026-11-19T09:00:00Z', taskId: 'contract', sessionId: 's1', waitId: 's1', due: '2026-11-20', checkBack: { at: '2026-11-21T09:00:00.000Z', by: 'atlas' } },
      { key: 'task:bank@2026-11-19T08:00:00Z', kind: 'do', space: 'main', title: 'bank', text: 'Call the bank', since: '2026-11-19T08:00:00Z', taskId: 'bank', waitId: 'w0', repeating: true },
    ])
  })

  it('a do wait for someone else is not the viewer\'s item; every item names its wait', () => {
    const theirs = t('theirs', { who: 'kim', kind: 'do', why: 'Send the invoice', since: '2026-11-19T09:00:00Z' })
    expect(inboxItems([theirs], 'dev-user', [], NOW).live).toEqual([])
    const review = t('rev', { who: 'dev-user', kind: 'review', why: 'Review: done', since: '2026-11-19T09:00:00Z', session_id: 'b' })
    expect(inboxItems([review], 'dev-user', [], NOW).live[0]).toMatchObject({ kind: 'review', waitId: 'b' })
    expect(inboxItems([review], 'dev-user', [], NOW).live[0]).not.toHaveProperty('checkBack')
  })
})
