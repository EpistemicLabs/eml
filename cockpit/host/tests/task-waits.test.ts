import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mostUrgent, sameWaits, urgentWaitOf, waitsBody, waitsOf, withoutSession, withSessionWait, type Wait } from '../src/domain/task-waits.js'

const require = createRequire(import.meta.url)
const { mostUrgentWait } = require('@engramprotocol/core') as { mostUrgentWait: (w: Wait[]) => Wait | undefined }

const w = (id: string, kind: string | undefined, since?: string, who = 'lasse'): Wait => ({ id, who, ...(kind ? { kind } : {}), ...(since ? { since } : {}), session_id: id })

describe('a task\'s waits', () => {
  it('reads waits, else the one wait an older waiting_on stands for', () => {
    expect(waitsOf({ waits: [w('a', 'question'), { id: 'x' }, null] })).toEqual([w('a', 'question')])
    expect(waitsOf({ waiting_on: { who: 'lasse', kind: 'go', session_id: 's1' } })).toEqual([{ id: 's1', who: 'lasse', kind: 'go', session_id: 's1' }])
    expect(waitsOf({ waiting_on: { who: 'kim' } })).toEqual([{ id: 'waiting_on', who: 'kim' }])
    expect(waitsOf({ waiting_on: { why: 'no who' } })).toEqual([])
    expect(waitsOf(undefined)).toEqual([])
  })

  it('picks the most urgent wait the way core does', () => {
    const lists: Wait[][] = [
      [w('a', 'question', '2026-11-19T09:00:00.000Z'), w('b', 'review', '2026-11-19T10:00:00.000Z')],
      [w('a', 'question', '2026-11-19T09:00:00.000Z'), w('b', 'question', '2026-11-19T08:00:00.000Z')],
      [w('a', 'outside'), w('b', undefined, '2026-11-19T08:00:00.000Z'), w('c', 'stopped')],
      [w('a', 'go'), w('b', 'go', '2026-11-19T08:00:00.000Z')],
      [w('a', 'question'), w('b', 'question')],
      [],
    ]
    for (const list of lists) expect(mostUrgent(list)).toEqual(mostUrgentWait(list))
    expect(urgentWaitOf({ waits: lists[0] })).toEqual({ who: 'lasse', kind: 'question', since: '2026-11-19T09:00:00.000Z', session_id: 'a' })
    // a parked wait ranks after every wait that is not, and the flat form leaves its snooze out
    const parked = [{ ...w('a', 'question'), snoozed_until: 'open' }, w('b', 'outside')]
    expect(mostUrgent(parked)).toEqual(mostUrgentWait(parked as never))
    expect(urgentWaitOf({ waits: [parked[0]] })).toMatchObject({ snoozed_until: 'open' })
  })

  it('one wait per session: replaced in place, kept as it is when the same, removed by session', () => {
    const start = [w('a', 'question', '2026-11-19T09:00:00.000Z'), w('b', 'review', '2026-11-19T09:30:00.000Z')]
    const same = withSessionWait(start, { who: 'lasse', kind: 'question', since: '2026-11-19T11:00:00.000Z', session_id: 'a' })
    expect(sameWaits(same, start)).toBe(true)
    const next = withSessionWait(start, { who: 'lasse', kind: 'question', why: 'new?', since: '2026-11-19T11:00:00.000Z', session_id: 'a' })
    expect(next.map((x) => [x.id, x.why])).toEqual([['a', 'new?'], ['b', undefined]])
    expect(withSessionWait(start, { who: 'lasse', kind: 'go', since: 'x', session_id: 'c' }).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(withoutSession(start, 'a').map((x) => x.id)).toEqual(['b'])
  })

  it('writes only what core accepts, and null for none', () => {
    expect(waitsBody([])).toEqual({ waits: null })
    expect(waitsBody([{ id: 'w', who: 'kim', kind: 'later', since: 'soon', why: 'r', extra: 1 } as unknown as Wait])).toEqual({ waits: [{ id: 'w', who: 'kim', why: 'r' }] })
  })
})
