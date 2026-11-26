import { describe, it, expect } from 'vitest'
import { cronInWords, firedText, firedWords, SCHEDULE_TASK_RULE, startedBy } from '../src/domain/run-text.js'
import type { JobRun } from '../src/domain/job.js'

// What a session reads when the cockpit fires its task's schedule: one line naming what fired, each repeating time
// in words and as its cron text, the wake-up with its reason.

const NOW = Date.parse('2026-11-09T00:00:30Z') // Monday 08:00:30 in Asia/Makassar
const run = (patch: Partial<JobRun> = {}): JobRun => ({
  id: 'r1', jobId: 't1', trigger: 'schedule', number: 3, dueAt: '2026-11-09T00:00:00.000Z', createdAt: '2026-11-09T00:00:30.000Z',
  status: 'waiting', attempts: 0, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: null, ...patch,
})

describe('cronInWords', () => {
  it('says the common shapes in words', () => {
    expect(cronInWords('0 8 * * 1-5')).toBe('on weekdays at 08:00')
    expect(cronInWords('0 8 * * MON-FRI')).toBe('on weekdays at 08:00')
    expect(cronInWords('30 7 * * *')).toBe('every day at 07:30')
    expect(cronInWords('0 18,22 * * 1-5')).toBe('on weekdays at 18:00 and 22:00')
    expect(cronInWords('0 9,13,17 * * *')).toBe('every day at 09:00, 13:00 and 17:00')
    expect(cronInWords('0 9 * * 1')).toBe('every Monday at 09:00')
    expect(cronInWords('30 9 * * 1,4')).toBe('every Monday and Thursday at 09:30')
    expect(cronInWords('0 10 * * 0,6')).toBe('at the weekend at 10:00')
    expect(cronInWords('0 10 * * 7')).toBe('every Sunday at 10:00')
    expect(cronInWords('0 7 1 * *')).toBe('on day 1 of every month at 07:00')
    expect(cronInWords('0 7 1,15 * *')).toBe('on day 1 and 15 of every month at 07:00')
    expect(cronInWords('15 * * * *')).toBe('every hour at :15')
    expect(cronInWords('15 * * * 1-5')).toBe('every hour at :15 on weekdays')
    expect(cronInWords('0 8 * * 0-6')).toBe('every day at 08:00')
  })

  it('has no words for what these shapes do not fit, or for what is no cron', () => {
    for (const cron of ['*/15 * * * *', '0,30 8 * * *', '0 8 * 1 *', '0 8 1 * 1', '0 0-23 * * *', '0 8 1-10 * *', 'not a cron', '0 8 * *', '61 8 * * *']) expect(cronInWords(cron)).toBeNull()
  })
})

describe('firedWords', () => {
  it('names a repeating time in words and as its cron text, with when it was due in the schedule\'s zone', () => {
    const fired = { crons: [{ cron: '0 8 * * 1-5', dueAt: '2026-11-09T00:00:00.000Z' }], timeZone: 'Asia/Makassar' }
    expect(firedWords(run({ fired }), NOW, 'UTC')).toBe('the repeating time on weekdays at 08:00 (cron "0 8 * * 1-5", Asia/Makassar), due Mon 9 Nov 08:00')
  })

  it('shows a cron it has no words for as its text alone, and reads times in the user\'s zone when the schedule names none', () => {
    const fired = { crons: [{ cron: '*/30 * * * *', dueAt: '2026-11-09T00:00:00.000Z' }] }
    expect(firedWords(run({ fired }), NOW, 'Europe/Berlin')).toBe('the repeating time (cron "*/30 * * * *", Europe/Berlin), due Mon 9 Nov 01:00')
  })

  it('names every time of one firing: the wake-up first, then each repeating time', () => {
    const fired = {
      wake: { at: '2026-11-08T23:30:00.000Z', why: 'Check the reply.', bySession: 's1' },
      crons: [{ cron: '0 8 * * 1-5', dueAt: '2026-11-09T00:00:00.000Z' }, { cron: '0 8 * * 1', dueAt: '2026-11-09T00:00:00.000Z' }],
      timeZone: 'Asia/Makassar',
    }
    expect(firedWords(run({ fired }), NOW, 'UTC')).toBe(
      'the wake-up set for Mon 9 Nov 07:30 (Asia/Makassar), 31 min late; '
      + 'the repeating time on weekdays at 08:00 (cron "0 8 * * 1-5", Asia/Makassar), due Mon 9 Nov 08:00; '
      + 'the repeating time every Monday at 08:00 (cron "0 8 * * 1", Asia/Makassar), due Mon 9 Nov 08:00',
    )
  })

  it('says how late a time is once it is more than two minutes', () => {
    const fired = { crons: [{ cron: '0 8 * * *', dueAt: '2026-11-09T00:00:00.000Z' }], timeZone: 'UTC' }
    expect(firedWords(run({ fired }), Date.parse('2026-11-09T00:02:00Z'), 'UTC')).not.toContain('late')
    expect(firedWords(run({ fired }), Date.parse('2026-11-09T07:00:00Z'), 'UTC')).toMatch(/due Mon 9 Nov 00:00, 420 min late$/)
  })

  it('names a channel message, a run by hand, and a scheduled run from before it kept what fired', () => {
    expect(firedWords(run({ trigger: 'mail' }), NOW, 'UTC')).toBe('a new message on mail')
    expect(firedWords(run({ trigger: 'manual' }), NOW, 'UTC')).toBe('the owner started it by hand (Run now)')
    expect(firedWords(run(), NOW, 'Asia/Makassar')).toBe('a time due Mon 9 Nov 08:00 (Asia/Makassar)')
  })
})

describe('firedText', () => {
  const task = { id: '11111111-2222-4333-8444-555555555555', name: 'Daily brief' }

  it('is one bracketed line: who sends it, the run, what fired, how to end the turn, and never to close a scheduled task', () => {
    const text = firedText(run({ fired: { crons: [{ cron: '0 8 * * 1-5', dueAt: '2026-11-09T00:00:00.000Z' }], timeZone: 'Asia/Makassar' } }), task, NOW, 'UTC')
    expect(text).toBe(
      '[From the cockpit, not from your user: run 3 for task "Daily brief" (11111111). '
      + 'What fired: the repeating time on weekdays at 08:00 (cron "0 8 * * 1-5", Asia/Makassar), due Mon 9 Nov 08:00. '
      + `Nobody may be watching: end your turn with end_turn if you have it. ${SCHEDULE_TASK_RULE}]`,
    )
  })

  it('gives the wake-up\'s reason after the line, and a channel message\'s text', () => {
    const woken = firedText(run({ fired: { wake: { at: '2026-11-09T00:00:00.000Z', why: 'Check whether the customer answered.\nIf not, write again.', bySession: 's1' } } }), task, NOW, 'Asia/Makassar')
    expect(woken.split('\n\n')).toEqual([
      expect.stringMatching(/^\[From the cockpit.*What fired: the wake-up set for Mon 9 Nov 08:00 \(Asia\/Makassar\)\. .*\]$/),
      'The wake-up\'s reason: Check whether the customer answered.\nIf not, write again.',
    ])
    const mailed = firedText(run({ trigger: 'mail', message: '2 new mails from customer.example' }), task, NOW, 'UTC')
    expect(mailed.split('\n\n')).toEqual([expect.stringContaining('What fired: a new message on mail.'), '2 new mails from customer.example'])
  })

  it('adds no reason for a wake-up that has none', () => {
    expect(firedText(run({ fired: { wake: { at: '2026-11-09T00:00:00.000Z', why: null, bySession: null } } }), task, NOW, 'UTC')).not.toContain('\n')
  })
})

describe('startedBy', () => {
  it('says what started a new session, as its prompt begins', () => {
    expect(startedBy({ trigger: 'schedule' })).toBe('The task\'s schedule')
    expect(startedBy({ trigger: 'manual' })).toBe('The task\'s owner (Run now)')
    expect(startedBy({ trigger: 'mail' })).toBe('A new message on mail')
  })
})
