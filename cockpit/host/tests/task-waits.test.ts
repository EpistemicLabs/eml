import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mostUrgent, reviewsOn, sameWaits, urgentWaitOf, waitsBody, waitsOf, withoutReviewsOn, withoutSession, withoutWaits, withSessionWait, type Wait } from '../src/domain/task-waits.js'

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

  it('takes the reviews on one person off, and leaves their questions and everyone else\'s waits', () => {
    const waits = [w('a', 'review'), w('b', 'question'), w('c', 'review', undefined, 'kim'), w('d', undefined)]
    expect(withoutReviewsOn(waits, 'lasse').map((x) => x.id)).toEqual(['b', 'c', 'd'])
    // nobody named (a cockpit without a viewer): every review
    expect(withoutReviewsOn(waits, undefined).map((x) => x.id)).toEqual(['b', 'd'])
  })

  it('counts a wait from before kinds existed as a review when its why says so, as the Inbox does', () => {
    const waits: Wait[] = [{ id: 'old', who: 'lasse', why: 'Review: brief written' }, { id: 'ask', who: 'lasse', why: 'Which list?' }]
    expect(reviewsOn(waits, 'lasse')).toEqual([{ id: 'old' }])
    expect(withoutReviewsOn(waits, 'lasse').map((x) => x.id)).toEqual(['ask'])
    // The one wait an older waiting_on stands for.
    expect(withoutReviewsOn(waitsOf({ waiting_on: { who: 'lasse', why: 'Review the draft' } }), 'lasse')).toEqual([])
  })

  it('names a wait by its id and the moment it began: the same session\'s later wait is another one', () => {
    const first = w('s1', 'review', '2026-11-19T08:00:00.000Z')
    const later = w('s1', 'review', '2026-11-20T08:00:00.000Z')
    const refs = reviewsOn([first, w('s2', 'question')], 'lasse')
    expect(refs).toEqual([{ id: 's1', since: '2026-11-19T08:00:00.000Z' }])
    expect(withoutWaits([first, w('s2', 'question')], refs).map((x) => x.id)).toEqual(['s2'])
    expect(withoutWaits([later], refs)).toEqual([later])
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

  it('a session\'s wait whose due changed is replaced, and two lists that differ only in a due are not the same', () => {
    const due = (d?: string) => ({ ...w('a', 'do', '2026-11-19T09:00:00.000Z'), ...(d ? { due: d } : {}) })
    const start = [due('2026-11-20')]
    const moved = withSessionWait(start, { who: start[0].who, kind: 'do', since: '2026-11-19T11:00:00.000Z', session_id: 'a', due: '2026-11-21' })
    expect(moved.map((x) => [x.id, x.due, x.since])).toEqual([['a', '2026-11-21', '2026-11-19T11:00:00.000Z']])
    expect(sameWaits(moved, start)).toBe(false)
    expect(sameWaits([due()], [due('2026-11-20')])).toBe(false)
    expect(sameWaits([due('2026-11-20')], [due('2026-11-20')])).toBe(true)
    // the same due again leaves the wait as it is, its since too
    expect(withSessionWait(start, { who: start[0].who, kind: 'do', since: '2026-11-19T11:00:00.000Z', session_id: 'a', due: '2026-11-20' })).toEqual(start)
  })

  it('writes only what core accepts, and null for none', () => {
    expect(waitsBody([])).toEqual({ waits: null })
    expect(waitsBody([{ id: 'w', who: 'kim', kind: 'later', since: 'soon', why: 'r', extra: 1 } as unknown as Wait])).toEqual({ waits: [{ id: 'w', who: 'kim', why: 'r' }] })
  })
})
