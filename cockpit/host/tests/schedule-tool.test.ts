import { describe, it, expect } from 'vitest'
import {
  describeTask, everyParagraph, findTask, limitRefusal, mailParagraph, mailTrigger, narrowedProfile, nextRuns, readAt, scheduledCount, timesInWords, withParagraph, type ToolTask,
} from '../src/domain/schedule-tool.js'
import { JOB_LIMITS, newRecord, type JobRun } from '../src/domain/job.js'

const NOW = Date.parse('2026-11-09T00:00:00Z') // Monday 08:00 in Asia/Makassar (UTC+8)
const ZONE = 'Asia/Makassar'
const task = (id: string, name: string, schedule?: Record<string, unknown> | null, more: Partial<ToolTask> = {}): ToolTask => ({
  id, title: `kebab-${id}`, status: 'active', content: 'Text.', ...more,
  properties: { display_title: name, ...(schedule ? { delegation: { agent: 'atlas', schedule } } : {}), ...more.properties },
})
const WEEKDAYS = { crons: ['0 8 * * 1-5'], time_zone: ZONE }

describe('the task a key names', () => {
  const tasks = [task('aaaaaaaa-1111', 'Daily brief', WEEKDAYS), task('aaaaaaaa-2222', 'Refund'), task('bbbbbbbb-3333', 'Refund', WEEKDAYS), task('cccccccc-4444', 'Notes')]
  const listed = (t: ToolTask) => Boolean(t.properties?.delegation?.schedule)

  it('finds it by its id, by the first 8 characters of its id, or by its exact display title whatever the case', () => {
    expect(findTask(tasks, 'cccccccc-4444', listed)).toMatchObject({ id: 'cccccccc-4444' })
    expect(findTask(tasks, 'bbbbbbbb', listed)).toMatchObject({ id: 'bbbbbbbb-3333' })
    expect(findTask(tasks, ' daily BRIEF ', listed)).toMatchObject({ id: 'aaaaaaaa-1111' })
    expect(findTask(tasks, 'Notes', listed)).toMatchObject({ id: 'cccccccc-4444' })
  })

  it('takes fewer than 8 characters for a name, never for an id', () => {
    expect(findTask(tasks, 'ccccccc', listed)).toEqual({ none: true })
    expect(findTask(tasks, 'Daily', listed)).toEqual({ none: true })
  })

  it('says how many fit when the key does not tell them apart; a title prefers the task that has a schedule', () => {
    expect(findTask(tasks, 'aaaaaaaa', listed)).toEqual({ many: 2 })
    // Two tasks are called Refund: the one with a schedule is the one the tool lists.
    expect(findTask(tasks, 'Refund', listed)).toMatchObject({ id: 'bbbbbbbb-3333' })
    expect(findTask(tasks, 'Refund', () => false)).toEqual({ many: 2 })
    expect(findTask(tasks, 'Refund', () => true)).toEqual({ many: 2 })
  })

  it('an id wins over another task\'s name', () => {
    const tricky = [...tasks, task('dddddddd-5555', 'cccccccc-4444', WEEKDAYS)]
    expect(findTask(tricky, 'cccccccc-4444', listed)).toMatchObject({ id: 'cccccccc-4444' })
  })
})

describe('a call\'s one time', () => {
  it('reads at in the zone and gives the instant', () => {
    expect(readAt('2026-11-13T10:00', ZONE, NOW, JOB_LIMITS.maxAheadMs)).toEqual({ at: '2026-11-13T02:00:00.000Z' })
    expect(readAt('2026-11-13T10:00', 'UTC', NOW, JOB_LIMITS.maxAheadMs)).toEqual({ at: '2026-11-13T10:00:00.000Z' })
  })

  it('refuses what is no time, a time that has passed and one more than a year ahead', () => {
    expect(readAt('Friday', ZONE, NOW, JOB_LIMITS.maxAheadMs)).toEqual({ error: 'at: "Friday" is not a date and time; write it like 2026-11-13T10:00 (read in Asia/Makassar)' })
    expect(readAt('2026-11-08T08:00', ZONE, NOW, JOB_LIMITS.maxAheadMs)).toEqual({ error: 'at: Sun 8 Nov 08:00 (Asia/Makassar) has passed' })
    expect(readAt('2026-11-09T08:00', ZONE, NOW, JOB_LIMITS.maxAheadMs)).toMatchObject({ error: expect.stringContaining('has passed') })
    expect(readAt('2028-01-01T08:00', ZONE, NOW, JOB_LIMITS.maxAheadMs)).toEqual({ error: 'at: at most a year ahead' })
  })
})

describe('what a time is for, in the task\'s text', () => {
  it('a repeating time\'s prompt becomes its own paragraph', () => {
    expect(everyParagraph(' 0 8 * * 1-5 ', ' Write the brief. ')).toBe('Every 0 8 * * 1-5: Write the brief.')
    expect(withParagraph('Keep Acme happy.\n', 'Every 0 8 * * 1-5: Write the brief.')).toBe('Keep Acme happy.\n\nEvery 0 8 * * 1-5: Write the brief.')
    expect(withParagraph('', 'Every 0 8 * * 1-5: Write the brief.')).toBe('Every 0 8 * * 1-5: Write the brief.')
    expect(withParagraph(undefined, mailParagraph('Draft replies.'))).toBe('On mail: Draft replies.')
  })

  it('is not written twice', () => {
    expect(withParagraph('Keep Acme happy.\n\nEvery 0 8 * * 1-5: Write the brief.', 'Every 0 8 * * 1-5: Write the brief.')).toBeNull()
  })
})

describe('how many tasks of a space hold a schedule', () => {
  it('counts the open tasks with a schedule', () => {
    const tasks = [task('a', 'A', WEEKDAYS), task('b', 'B'), task('c', 'C', { at: '2026-11-13T02:00:00.000Z' }), task('d', 'D', WEEKDAYS, { status: 'resolved' }), task('e', 'E', { ...WEEKDAYS, paused: true })]
    expect(scheduledCount(tasks)).toBe(3)
  })

  it('takes the 100th and refuses the 101st', () => {
    expect(limitRefusal(99, JOB_LIMITS.perSpace)).toBeNull()
    expect(limitRefusal(100, JOB_LIMITS.perSpace)).toBe('this space already has 100 tasks with a schedule; end one first (at most 100)')
    expect(JOB_LIMITS.perSpace).toBe(100)
  })
})

describe('the tools a task\'s sessions keep', () => {
  it('gives a new record at most its maker\'s tools, minus what the call denies', () => {
    expect(narrowedProfile(undefined, null, undefined)).toBeNull()
    expect(narrowedProfile(undefined, { deniedTools: ['Bash'], mcpServers: ['gmail'] }, ['WebFetch'])).toEqual({ deniedTools: ['Bash', 'WebFetch'], mcpServers: ['gmail'] })
    expect(narrowedProfile(undefined, null, ['WebFetch'])).toEqual({ deniedTools: ['WebFetch'], mcpServers: null })
  })

  it('never widens what the record allowed, whoever calls', () => {
    const before = { deniedTools: ['Bash'], mcpServers: ['gmail', 'slack'] }
    // A caller with every tool changes nothing.
    expect(narrowedProfile(before, null, undefined)).toEqual(before)
    expect(narrowedProfile(before, null, [])).toEqual(before)
    // A narrower caller narrows the task's sessions to what it has itself.
    expect(narrowedProfile(before, { deniedTools: ['SendMessage'], mcpServers: ['slack', 'drive'] }, ['Bash'])).toEqual({ deniedTools: ['Bash', 'SendMessage'], mcpServers: ['slack'] })
    expect(narrowedProfile(null, { deniedTools: ['Bash'], mcpServers: null }, undefined)).toEqual({ deniedTools: ['Bash'], mcpServers: null })
  })

  it('refuses a deny list that is none', () => {
    expect(narrowedProfile(undefined, null, 'Bash')).toBe('invalid')
    expect(narrowedProfile(undefined, null, ['rm -rf'])).toBe('invalid')
  })
})

describe('the mail a task listens on', () => {
  it('reads domains and addresses, lower-cased and once each', () => {
    expect(mailTrigger({ domains: ['Acme.example', 'acme.example'], addresses: ['Boss@Partner.example'] }))
      .toEqual({ type: 'mail', match: [{ kind: 'address', address: 'boss@partner.example' }, { kind: 'domain', domain: 'acme.example' }] })
    expect(mailTrigger(undefined)).toBeNull()
  })

  it('refuses what is no address or domain, and an empty list', () => {
    expect(mailTrigger({ domains: ['@acme.example'] })).toBe('not a mail address or domain: @acme.example (a domain is written without @, e.g. example.com)')
    expect(mailTrigger({})).toBe('mail needs at least one address or domain')
    expect(mailTrigger(['acme.example'])).toBe('mail is { addresses?: [...], domains?: [...] }')
  })
})

describe('a task\'s schedule as the agent reads it', () => {
  it('lists the next times of the repeating times and the wake-up together, oldest first', () => {
    const schedule = { ...WEEKDAYS, at: '2026-11-10T04:00:00.000Z' }
    expect(nextRuns(schedule, NOW, 3).map((at) => new Date(at).toISOString())).toEqual(['2026-11-10T00:00:00.000Z', '2026-11-10T04:00:00.000Z', '2026-11-11T00:00:00.000Z'])
    // A wake-up alone is one time; a paused schedule and none have nothing ahead.
    expect(nextRuns({ at: '2026-11-10T04:00:00.000Z' }, NOW, 3)).toHaveLength(1)
    expect(nextRuns({ ...WEEKDAYS, paused: true }, NOW, 3)).toEqual([])
    expect(nextRuns(null, NOW, 3)).toEqual([])
    // An end after so many runs, and one at a time, cut the list.
    expect(nextRuns(WEEKDAYS, NOW, 3, 2)).toHaveLength(2)
    expect(nextRuns(WEEKDAYS, NOW, 3, 0)).toEqual([])
    expect(nextRuns({ ...WEEKDAYS, ends_at: '2026-11-11T00:00:00.000Z' }, NOW, 3)).toHaveLength(2)
  })

  it('says what wakes it in one line', () => {
    expect(timesInWords({ crons: ['0 8 * * 1-5', '0 18 * * *'], at: '2026-11-13T02:00:00.000Z' }, [], ZONE)).toBe('cron "0 8 * * 1-5" + cron "0 18 * * *" + once, Fri 13 Nov 10:00 (Asia/Makassar)')
    expect(timesInWords(null, [{ type: 'mail', match: [{ kind: 'domain', domain: 'acme.example' }, { kind: 'address', address: 'a@b.example' }] }], ZONE)).toBe('on mail from acme.example, a@b.example')
    expect(timesInWords(WEEKDAYS, [{ type: 'slack', match: [] }], ZONE)).toBe('cron "0 8 * * 1-5" (Asia/Makassar) + on slack')
    expect(timesInWords(null, [], ZONE)).toBe('no schedule')
  })

  it('describes it with its next runs in words, read in the schedule\'s zone', () => {
    expect(describeTask(task('aaaaaaaa-1111', 'Daily brief', WEEKDAYS), undefined, [], NOW, 'UTC'))
      .toBe('"Daily brief" (aaaaaaaa): cron "0 8 * * 1-5" (Asia/Makassar)\n  next: Tue 10 Nov 08:00, Wed 11 Nov 08:00, Thu 12 Nov 08:00')
  })

  it('names its state, goal, limit, end, project and last run', () => {
    const record = { ...newRecord({ id: 'aaaaaaaa-1111', spaceId: null }, '2026-11-01T00:00:00.000Z'), limited: true, end: { afterRuns: 5 }, runCount: 4, pausedReason: 'run 4 failed: no room', grants: [{ tool: 'chrome' as const, until: '2026-11-09T01:00:00.000Z', reason: null }] }
    const run: JobRun = { id: 'r', jobId: 'aaaaaaaa-1111', trigger: 'schedule', number: 4, dueAt: '2026-11-06T00:00:00.000Z', createdAt: '', status: 'failed', attempts: 1, nextAttemptAt: null, sessionId: null, startedAt: null, finishedAt: null, outcome: null, note: 'no room' }
    const text = describeTask(task('aaaaaaaa-1111', 'Refund', { ...WEEKDAYS, paused: true, ends_at: '2026-12-01T00:00:00.000Z', at: '2026-11-13T02:00:00.000Z', by_session: 's1' }, { properties: { goal: 'Refund on the card' } }), record, [run], NOW, ZONE, 'EML')
    expect(text.split('\n')).toEqual([
      '"Refund" (aaaaaaaa): cron "0 8 * * 1-5" + once, Fri 13 Nov 10:00 (Asia/Makassar)',
      '  state: paused (run 4 failed: no room)',
      '  goal: Refund on the card',
      '  limited: no shell, no messages to sessions, only the brain MCP; the schedule tool reaches only this task; lent for now: chrome',
      '  the wake-up continues the session that set it',
      '  ends: after 1 more run, at Tue 1 Dec 08:00',
      '  new sessions start in: EML',
      '  last run: Fri 6 Nov 08:00, failed (no room)',
    ])
  })

  it('says when its channel waits for the user, when its end has passed and when the task is closed', () => {
    const mail = { ...newRecord({ id: 'a', spaceId: null }, ''), triggers: [{ type: 'mail' as const, match: [{ kind: 'domain', domain: 'acme.example' }] }], pendingApproval: true }
    expect(describeTask(task('aaaaaaaa', 'Acme mail'), mail, [], NOW, ZONE)).toBe('"Acme mail" (aaaaaaaa): on mail from acme.example\n  state: waiting for the user\'s OK on the task')
    expect(describeTask(task('aaaaaaaa', 'Old', { ...WEEKDAYS, ends_at: '2026-11-01T00:00:00.000Z' }), undefined, [], NOW, ZONE)).toContain('state: past its end: nothing fires')
    expect(describeTask(task('aaaaaaaa', 'Done', WEEKDAYS, { status: 'resolved' }), undefined, [], NOW, ZONE)).toContain('state: the task is closed: nothing fires')
  })
})
