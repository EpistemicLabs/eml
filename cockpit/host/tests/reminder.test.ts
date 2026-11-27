import { describe, it, expect } from 'vitest'
import { fireReminder, reminderWait } from '../src/application/reminder.js'

// A person's wake-up fired (application/reminder.ts): one write adds a do wait for them, takes the wake-up off the
// task and journals it. A task whose wake-up is another one by now is not written.

type Task = { id: string; status: string; rev?: number; properties: Record<string, unknown> }

function brain(task: Task) {
  const posts: Array<Record<string, unknown>> = []
  return {
    posts,
    get: async () => structuredClone(task),
    post: async (_path: string, body: Record<string, unknown>) => { posts.push(body); return {} },
  }
}

const AT = '2026-11-28T02:00:00.000Z'
const R = { at: AT, who: 'kim', why: 'Call the vendor.', zone: 'Europe/Berlin', now: '2026-11-28T02:00:30.000Z' }

describe('fireReminder', () => {
  it('adds a do wait for the person, removes the wake-up and keeps the repeating times, with a journal line', async () => {
    const b = brain({ id: 't1', status: 'active', properties: { schedule: { crons: ['0 8 * * 1'], at: AT, why: 'Call the vendor.', by: 'kim' }, waits: [{ id: 's1', who: 'kim', kind: 'review' }] } })
    await fireReminder(b as never, 't1', R)
    expect(b.posts).toHaveLength(1)
    expect(b.posts[0].schedule).toEqual({ crons: ['0 8 * * 1'] })
    expect(b.posts[0].waits).toEqual([
      { id: 's1', who: 'kim', kind: 'review' },
      { id: `reminder:${AT}`, who: 'kim', kind: 'do', why: 'Call the vendor.', since: R.now },
    ])
    expect(b.posts[0].text).toMatch(/^Reminder fired for kim at .+ \(Europe\/Berlin\): Call the vendor\. It is in their Inbox as their move\.$/)
  })

  it('writes nothing when the task\'s wake-up is another one by now', async () => {
    const b = brain({ id: 't1', status: 'active', properties: { schedule: { at: '2026-11-29T02:00:00.000Z', by: 'kim' } } })
    await fireReminder(b as never, 't1', R)
    expect(b.posts).toEqual([])
  })

  it('a reminder without a reason still reads as one', () => {
    expect(reminderWait({ at: AT, who: 'kim', why: null, now: R.now }).why).toBe('Reminder')
  })
})
