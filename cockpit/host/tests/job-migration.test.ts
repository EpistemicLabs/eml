import { describe, it, expect } from 'vitest'
import { cronParagraph, jobMigrationReport, MIGRATED_AWAY, planJobMigration, stepOf, type JobMigrationInput, type JobMigrationTask } from '../src/domain/job-migration.js'
import type { JobV1 } from '../src/domain/job-v1.js'
import type { JobRun } from '../src/domain/job.js'

// Thursday 26 November 2026, 10:00 UTC.
const NOW = Date.parse('2026-11-26T10:00:00.000Z')
const AHEAD = '2026-11-27T02:00:00.000Z'
const LATER = '2026-11-28T02:00:00.000Z'
const PAST = '2026-11-25T02:00:00.000Z'

let n = 0
const job = (patch: Partial<JobV1> = {}): JobV1 => ({
  id: `job-${++n}`, name: 'Daily brief', kind: 'routine', spaceId: null, createdBy: 's-maker', createdAt: `2026-11-01T00:00:${String(n).padStart(2, '0')}.000Z`, updatedAt: '2026-11-01T00:00:00.000Z',
  taskId: 't1', prompt: 'Write the brief.', target: { type: 'worker', projectId: 'bp-ops' }, triggers: [{ type: 'schedule', cron: '0 8 * * 1-5', timeZone: 'Europe/Berlin' }],
  toolProfile: null, reply: {}, end: null, notify: 'needs-me', paused: false, pausedReason: null, endedAt: null, nextRunAt: '2026-11-27T07:00:00.000Z', runCount: 0, failures: 0, ...patch,
})
const cron = (expr: string, patch: Partial<JobV1> = {}) => job({ triggers: [{ type: 'schedule', cron: expr, timeZone: 'Europe/Berlin' }], ...patch })
const once = (at: string, patch: Partial<JobV1> = {}) => job({ name: 'Check: reply', prompt: 'Look whether the reply came.', triggers: [{ type: 'schedule', at, timeZone: 'Europe/Berlin' }], nextRunAt: Date.parse(at) > NOW ? at : null, target: { type: 'session', sessionId: 'sess-1234-abcd' }, ...patch })
const run = (jobId: string, id: string, status: JobRun['status'] = 'finished', number = 1): JobRun => ({
  id, jobId, trigger: 'schedule', number, dueAt: '2026-11-20T08:00:00.000Z', createdAt: `2026-11-20T08:00:0${number}.000Z`, status, attempts: 1,
  nextAttemptAt: null, sessionId: 's1', startedAt: '2026-11-20T08:00:05.000Z', finishedAt: status === 'finished' ? '2026-11-20T08:10:00.000Z' : null, outcome: null, note: null,
})
const task = (id = 't1', patch: Partial<JobMigrationTask> = {}, properties: JobMigrationTask['properties'] = {}): JobMigrationTask => ({
  id, status: 'active', title: `task-${id}`, content: 'Keep the customer informed.', properties: { assignee_ids: ['lasse'], display_title: `Task ${id}`, ...properties }, ...patch,
})
const plan = (jobs: JobV1[], tasks: Array<JobMigrationTask | [string, null]> = [task()], patch: Partial<JobMigrationInput> = {}) => planJobMigration({
  jobs, runs: {}, keys: {}, space: { key: null, name: 'Main' }, me: 'lasse', now: NOW,
  tasks: Object.fromEntries(tasks.map((t) => (Array.isArray(t) ? t : [t.id, t]))),
  routineTaskOf: (j) => ({ title: `routine-${j.id}`, display_title: j.name, content: j.prompt, scope: 'project.ops', status: 'active', assignee_ids: ['lasse'] }),
  ...patch,
})

describe('planning jobs onto their tasks', () => {
  it('a repeating job: its cron is the task\'s repeating time, its prompt a paragraph of the task\'s text, its settings the record\'s', () => {
    const j = cron('0 8 * * 1-5', { notify: 'always', runCount: 4, failures: 1 })
    const [t] = plan([j]).tasks
    expect(t).toMatchObject({ taskId: 't1', outcome: 'moved', why: null, create: null, settles: [j.id], renamed: [j.id] })
    expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(t.brain).toEqual({
      // the brain takes a rewrite of the text only with a line that says what happened
      setSchedule: true, journal: ['Schedules moved onto tasks: what its repeating job did was added to the task\'s text, as "Every <cron>: …".'],
      content: 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.', appended: ['Every 0 8 * * 1-5: Write the brief.'],
    })
    expect(t.record).toEqual({
      id: 't1', spaceId: null, taskId: 't1', createdBy: 's-maker', createdAt: j.createdAt, updatedAt: '2026-11-26T10:00:00.000Z',
      triggers: [], projectId: 'bp-ops', toolProfile: null, reply: {}, end: null, notify: 'always', pausedReason: null,
      cursor: '2026-11-26T10:00:00.000Z', firedWake: null, lastRunAt: null, runCount: 4, failures: 1,
    })
    expect(cronParagraph('0 8 * * 1-5', ' Write the brief.\n')).toBe('Every 0 8 * * 1-5: Write the brief.')
  })

  it('two repeating jobs on one task: both crons, each prompt its own paragraph, one record from the older job', () => {
    const a = cron('0 8 * * 1-5', { notify: 'always', runCount: 3 })
    const b = cron('0 18 * * 1-5', { name: 'Evening brief', prompt: 'Write the evening brief.', notify: 'never', runCount: 2, failures: 2, limited: true })
    const [t, ...rest] = plan([b, a]).tasks
    expect(rest).toEqual([])
    expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5', '0 18 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(t.brain?.appended).toEqual(['Every 0 8 * * 1-5: Write the brief.', 'Every 0 18 * * 1-5: Write the evening brief.'])
    expect(t.brain?.content).toBe('Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.\n\nEvery 0 18 * * 1-5: Write the evening brief.')
    expect(t.brain?.journal).toEqual(['Schedules moved onto tasks: what its 2 repeating jobs did was added to the task\'s text, as "Every <cron>: …".'])
    // the older job's settings; the stricter one where two differ; runs counted together
    expect(t.record).toMatchObject({ id: 't1', notify: 'always', limited: true, runCount: 5, failures: 2 })
    expect(t.settles).toEqual([b.id, a.id])
    expect(t.renamed).toEqual([a.id, b.id])
    // the same cron twice is one repeating time
    expect(plan([cron('0 8 * * 1-5'), cron('0 8 * * 1-5', { prompt: 'Also check the inbox.' })]).tasks[0]).toMatchObject({
      schedule: { crons: ['0 8 * * 1-5'] }, brain: { appended: ['Every 0 8 * * 1-5: Write the brief.', 'Every 0 8 * * 1-5: Also check the inbox.'] },
    })
  })

  it('a repeating job plus a one-time job ahead on one task: the crons and the wake-up, with its reason and the session it wakes', () => {
    const [t] = plan([cron('0 8 * * 1-5'), once(AHEAD)]).tasks
    expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5'], at: AHEAD, why: 'Look whether the reply came.', by_session: 'sess-1234-abcd', time_zone: 'Europe/Berlin' })
    // only the repeating job's prompt goes into the task's text: the wake-up carries its own
    expect(t.brain?.appended).toEqual(['Every 0 8 * * 1-5: Write the brief.'])
    expect(t.jobs.map((j) => j.what)).toEqual([
      'cron "0 8 * * 1-5" (Europe/Berlin) → a repeating time of the task; its prompt is appended to the task\'s text',
      `once at ${AHEAD} → the task's wake-up, set by session sess-123; its prompt is the reason`,
    ])
  })

  it('two one-time jobs ahead on one task: the earlier is the wake-up, the later one\'s time and prompt go into the journal', () => {
    const later = once(LATER, { name: 'Check: invoice', prompt: 'Look whether the invoice was paid.' })
    const earlier = once(AHEAD)
    const [t] = plan([later, earlier]).tasks
    expect(t.schedule).toEqual({ at: AHEAD, why: 'Look whether the reply came.', by_session: 'sess-1234-abcd', time_zone: 'Europe/Berlin' })
    expect(t.brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [`A later one-time run was set too, for ${LATER}; a task has one wake-up, so it is noted here: "Look whether the invoice was paid."`] })
    expect(t.jobs.find((j) => j.id === later.id)?.what).toBe(`once at ${LATER} → not the task's wake-up: "Check: reply" comes earlier, and a task has one; its time and prompt are noted in the journal`)
    expect(t.settles.sort()).toEqual([later.id, earlier.id].sort())
  })

  it('a one-time job whose time has passed and that never ran is dropped, with a journal line; one that ran has nothing to carry', () => {
    const missed = once(PAST)
    const [t] = plan([missed]).tasks
    expect(t).toMatchObject({ outcome: 'moved', schedule: null, record: null, renamed: [], settles: [missed.id] })
    expect(t.brain).toEqual({ setSchedule: false, content: null, appended: [], journal: [`The one-time run "Check: reply" set for ${PAST} never ran; it was dropped when schedules moved onto tasks.`] })
    expect(t.jobs[0].what).toBe(`once at ${PAST} → dropped: its time has passed and it never ran; noted in the journal`)

    const ran = once(PAST, { runCount: 1 })
    const [u] = plan([ran], [task()], { runs: { [ran.id]: [run(ran.id, 'r1')] } }).tasks
    expect(u).toMatchObject({ brain: null, record: null, history: { [ran.id]: [{ id: 'r1', status: 'finished' }] } })
    expect(u.jobs[0].what).toBe(`once at ${PAST} → it has run: no time to carry over`)
    // the schedule the mirror left on the task for a job that is over is cleared
    const [v] = plan([once(PAST, { runCount: 1 })], [task('t1', {}, { delegation: { agent: 'atlas', schedule: { at: PAST } } })]).tasks
    expect(v).toMatchObject({ schedule: null, brain: { setSchedule: true } })
  })

  it('a check end_turn set is a one-time job like any other: the wake-up of its task, by its session', () => {
    const check = once(AHEAD, { origin: 'end_turn', createdBy: 'sess-1234-abcd' })
    const [t] = plan([check]).tasks
    expect(t.schedule).toMatchObject({ at: AHEAD, why: 'Look whether the reply came.', by_session: 'sess-1234-abcd' })
    expect(t.record).toMatchObject({ id: 't1', createdBy: 'sess-1234-abcd' })
    expect(t.record).not.toHaveProperty('origin')
  })

  it('a job with open runs: they go on under the task\'s record, with the rest of its history up to the limit', () => {
    const j = cron('0 8 * * 1-5', { runCount: 2 })
    const [t] = plan([j], [task()], { runs: { [j.id]: [run(j.id, 'r1', 'finished', 1), run(j.id, 'r2', 'started', 2)] }, keys: { [j.id]: { 'mail:1': '2026-11-20T08:00:00.000Z' } } }).tasks
    expect(t.runs.map((r) => [r.id, r.jobId, r.status])).toEqual([['r1', 't1', 'finished'], ['r2', 't1', 'started']])
    expect(t.keys).toEqual({ 'mail:1': '2026-11-20T08:00:00.000Z' })
    expect(t.record).toMatchObject({ lastRunAt: '2026-11-20T08:00:05.000Z', runCount: 2 })
    expect(t.history).toEqual({})
    // a one-time job that is running now has no time left, but its run keeps a record
    const going = once(PAST, { runCount: 1 })
    const [u] = plan([going], [task()], { runs: { [going.id]: [run(going.id, 'r3', 'started')] } }).tasks
    expect(u).toMatchObject({ schedule: null, record: { id: 't1', cursor: '2026-11-26T10:00:00.000Z' }, renamed: [going.id] })
    expect(u.runs).toMatchObject([{ id: 'r3', jobId: 't1', status: 'started' }])
    // more than the history keeps: the oldest finished ones go, open ones never
    const many = Array.from({ length: 105 }, (_, i) => ({ ...run(j.id, `h${i}`, i === 0 ? 'started' : 'finished', 1), createdAt: new Date(NOW - (200 - i) * 60_000).toISOString() }))
    const [w] = plan([j], [task()], { runs: { [j.id]: many } }).tasks
    expect(w.runs).toHaveLength(100)
    expect(w.runs[0].id).toBe('h0')
    expect(w.runs[1].id).toBe('h6')
  })

  it('a job whose task is closed is dropped: a journal line on the task, a schedule it still shows cleared, open runs closed', () => {
    const j = cron('0 8 * * 1-5')
    const closed = task('t1', { status: 'resolved' }, { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'] } } })
    const [t] = plan([j], [closed], { runs: { [j.id]: [run(j.id, 'r1', 'waiting'), run(j.id, 'r2', 'started', 2), run(j.id, 'r3', 'finished', 3)] } }).tasks
    expect(t).toMatchObject({ taskId: 't1', outcome: 'dropped', why: 'the task is closed (resolved)', schedule: null, record: null, runs: [], renamed: [], settles: [j.id] })
    expect(t.brain).toEqual({ setSchedule: true, content: null, appended: [], journal: ['A job of this task ("Daily brief": cron "0 8 * * 1-5" (Europe/Berlin)) ended when schedules moved onto tasks: the task is closed. Reopen it and set a schedule to bring it back.'] })
    // its runs stay as history under the job's id; none stays open
    expect(t.history[j.id].map((r) => [r.id, r.status, r.note])).toEqual([['r1', 'skipped', MIGRATED_AWAY], ['r2', 'finished', MIGRATED_AWAY], ['r3', 'finished', null]])
    // a closed task without a leftover schedule gets the journal line alone
    expect(plan([cron('0 8 * * 1-5')], [task('t1', { status: 'invalidated' })]).tasks[0].brain).toMatchObject({ setSchedule: false, journal: [expect.stringContaining('the task is closed')] })
  })

  it('a job whose task is gone is dropped and nothing is written', () => {
    const j = cron('0 8 * * 1-5')
    const [t] = plan([j], [['t1', null]]).tasks
    expect(t).toMatchObject({ taskId: 't1', outcome: 'dropped', why: 'its task is gone', brain: null, record: null, settles: [j.id] })
    expect(t.jobs[0].what).toBe('cron "0 8 * * 1-5" (Europe/Berlin) → dropped: its task is gone')
  })

  it('a job in another space is left for that space\'s pass', () => {
    const here = cron('0 8 * * 1-5')
    const there = cron('0 9 * * *', { spaceId: 'space-2', taskId: 't2' })
    const main = plan([here, there], [task(), task('t2')])
    expect(main.tasks.map((t) => t.settles)).toEqual([[here.id]])
    expect(main.elsewhere).toBe(1)
    const other = plan([here, there], [task(), task('t2')], { space: { key: 'space-2', name: 'Team' } })
    expect(other.tasks.map((t) => [t.taskId, t.settles, t.record?.spaceId])).toEqual([['t2', [there.id], 'space-2']])
  })

  it('a job on a task another member owns is dropped here and nothing is written: its schedule is left to their cockpit', () => {
    const j = cron('0 8 * * 1-5')
    const theirs = task('t1', {}, { assignee_ids: ['dominik'], delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } } })
    const [t] = plan([j], [theirs]).tasks
    expect(t).toMatchObject({ outcome: 'dropped', brain: null, record: null, renamed: [], settles: [j.id] })
    expect(t.why).toBe('the task is dominik\'s: its schedule is left to their cockpit, nothing is written')
    // the task's own schedule stays as its owner's cockpit has it
    expect(t.schedule).toEqual({ crons: ['0 7 * * *'], time_zone: 'UTC' })
    expect(t.jobs[0].what).toContain('the cockpit of the task\'s owner (dominik) fires what the task\'s schedule says')
  })

  describe('whose jobs move: the tasks this cockpit fires, by the engine\'s one owner rule (the first assignee, else the author)', () => {
    const shared = { space: { key: null, name: 'Team', shared: true } }
    const outcome = (t: JobMigrationTask, patch: Partial<JobMigrationInput> = shared) => plan([cron('0 8 * * 1-5')], [t], patch).tasks[0]

    it('moves the job of my task', () => {
      expect(outcome(task('t1', { ingested_by: 'dominik' }, { assignee_ids: ['lasse', 'dominik'] })).outcome).toBe('moved')
    })

    it('drops the job of another member\'s task, whoever wrote the task', () => {
      const t = outcome(task('t1', { ingested_by: 'lasse' }, { assignee_ids: ['dominik', 'lasse'] }))
      expect(t).toMatchObject({ outcome: 'dropped', brain: null, record: null })
      expect(t.why).toContain('the task is dominik\'s')
    })

    it('moves the job of a task nobody is assigned to that I authored', () => {
      expect(outcome(task('t1', { ingested_by: 'lasse' }, { assignee_ids: [] })).outcome).toBe('moved')
    })

    it('drops the job of a task nobody is assigned to that another member authored: their cockpit fires it', () => {
      const t = outcome(task('t1', { ingested_by: 'dominik' }, { assignee_ids: [] }))
      expect(t).toMatchObject({ outcome: 'dropped', brain: null, record: null })
      expect(t.jobs[0].what).toContain('the cockpit of the task\'s owner (dominik) fires what the task\'s schedule says')
    })

    it('drops the job of a task nobody owns at all in a shared space, and says no cockpit fires it', () => {
      const t = outcome(task('t1', {}, { assignee_ids: [] }))
      expect(t.outcome).toBe('dropped')
      expect(t.why).toBe('the task is nobody\'s (no assignee, no author): its schedule is left to their cockpit, nothing is written')
      expect(t.jobs[0].what).toContain('no cockpit fires a task nobody owns')
    })

    it('counts a space whose sharing is not confirmed, or not said, as shared', () => {
      const theirs = task('t1', { ingested_by: 'dominik' }, { assignee_ids: [] })
      expect(outcome(theirs, { space: { key: null, name: 'Team', shared: null } }).outcome).toBe('dropped')
      expect(outcome(theirs, {}).outcome).toBe('dropped')
    })

    it('moves every task\'s jobs in a local space: each task there is this member\'s', () => {
      const local = { space: { key: null, name: 'Main', shared: false } }
      expect(outcome(task('t1', { ingested_by: 'dominik' }, { assignee_ids: ['dominik'] }), local).outcome).toBe('moved')
      expect(outcome(task('t1', {}, { assignee_ids: [] }), local).outcome).toBe('moved')
    })
  })

  it('planned again against what it wrote, it writes nothing more to the brain', () => {
    const j = cron('0 8 * * 1-5')
    const first = plan([j, once(AHEAD)]).tasks[0]
    const written = task('t1', { content: first.brain!.content! }, { delegation: { agent: 'atlas', schedule: first.schedule! } })
    const again = plan([j, once(AHEAD)], [written]).tasks[0]
    expect(again.brain).toBeNull()
    expect(again.schedule).toEqual(first.schedule)
    expect(again.record).toMatchObject({ id: 't1' })
  })

  it('a paused job: with every timed job of the task paused the schedule is paused; one paused among running ones is left out and noted', () => {
    const [all] = plan([cron('0 8 * * 1-5', { paused: true, pausedReason: '3 failed runs in a row; last: run 4 failed' }), once(AHEAD, { paused: true })]).tasks
    expect(all.schedule).toMatchObject({ crons: ['0 8 * * 1-5'], at: AHEAD, paused: true })
    expect(all.record).toMatchObject({ pausedReason: '3 failed runs in a row; last: run 4 failed' })

    const sleeping = cron('0 18 * * 1-5', { name: 'Evening brief', prompt: 'Write the evening brief.', paused: true })
    const [mixed] = plan([cron('0 8 * * 1-5'), sleeping]).tasks
    expect(mixed.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(mixed.brain?.journal.slice(1)).toEqual(['A paused repeating job was not carried over when schedules moved onto tasks, since a task\'s schedule is paused as a whole. "Evening brief" (cron "0 18 * * 1-5", Europe/Berlin): what it did: "Write the evening brief."'])
    expect(mixed.record?.pausedReason).toBeNull()
    expect(mixed.settles).toContain(sleeping.id)
  })

  it('a task\'s repeating times are read in one zone: a job in another zone is left out and noted', () => {
    const berlin = cron('0 8 * * 1-5')
    const tokyo = job({ name: 'Tokyo brief', triggers: [{ type: 'schedule', cron: '0 9 * * *', timeZone: 'Asia/Tokyo' }] })
    const [t] = plan([tokyo, berlin]).tasks
    expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(t.brain?.journal.at(-1)).toContain('A repeating job in another time zone was not carried over')
    expect(t.jobs[1].what).toBe('cron "0 9 * * *" (Asia/Tokyo) → left out: the task\'s repeating times are read in Europe/Berlin; noted in the journal')
  })

  it('a prompt the task\'s text says already is not appended: the same words, or a prompt a scheduled hand-over built from the task', () => {
    const said = task('t1', { content: 'Every morning: Write the brief. Then send it.' })
    expect(plan([cron('0 8 * * 1-5')], [said]).tasks[0].brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [] })
    const built = cron('0 8 * * 1-5', { prompt: 'A scheduled job started you for "task-t1" (task t1).\nKeep the customer informed.\n\nNo checkpoint: do this run to the end on your own; ask only when you cannot go on.' })
    const [t] = plan([built]).tasks
    expect(t.brain).toMatchObject({ content: null, appended: [] })
    expect(t.jobs[0].what).toContain('its prompt is in the task\'s text already')
    // a task without text gets the paragraph as its text
    expect(plan([cron('0 8 * * 1-5')], [task('t1', { content: '' })]).tasks[0].brain?.content).toBe('Every 0 8 * * 1-5: Write the brief.')
  })

  it('a job that has ended leaves only its runs, as history under its id', () => {
    const done = cron('0 8 * * 1-5', { endedAt: '2026-11-20T00:00:00.000Z' })
    const [t] = plan([done], [task('t1', {}, { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'] } } })], { runs: { [done.id]: [run(done.id, 'r1')] } }).tasks
    expect(t).toMatchObject({ outcome: 'moved', schedule: null, record: null, renamed: [], settles: [done.id], history: { [done.id]: [{ id: 'r1' }] } })
    // the schedule its mirror left on the task goes
    expect(t.brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [] })
    expect(t.jobs[0].what).toBe('had ended: its runs stay as history')
  })

  it('moves the per-machine settings: channel triggers and their approval, reply mode, limited and lent tools, tool profile, where a session starts', () => {
    const mail = job({
      name: 'Customer mail', triggers: [{ type: 'mail', match: [{ kind: 'domain', domain: 'customer.example' }] }], nextRunAt: null, pendingApproval: true, reply: { mail: 'send' }, limited: true,
      grants: [{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: null }, { tool: 'SendMessage', until: '2026-11-26T09:00:00.000Z', reason: null }],
      toolProfile: { deniedTools: ['Bash'], mcpServers: null }, target: { type: 'worker', projectId: 'bp-customer', provider: 'codex' as never },
    })
    const [t] = plan([mail, cron('0 8 * * 1-5', { reply: { mail: 'draft' } })]).tasks
    expect(t.record).toMatchObject({
      triggers: [{ type: 'mail', match: [{ kind: 'domain', domain: 'customer.example' }] }], pendingApproval: true, limited: true,
      // drafting wins where two jobs differ; a grant that ran out is not carried
      reply: { mail: 'draft' }, grants: [{ tool: 'chrome', until: '2026-11-26T11:00:00.000Z', reason: null }],
      toolProfile: { deniedTools: ['Bash'], mcpServers: null }, projectId: 'bp-customer', provider: 'codex',
    })
    expect(t.settings).toEqual(expect.arrayContaining(['tells needs-me', 'limited, lent chrome', 'its tool profile', 'wakes on mail (1 sender), waiting for the user\'s OK', 'mail replies: draft', 'new sessions start in bp-customer with codex']))
    // a job only a channel wakes: no schedule, but a record that listens
    const [only] = plan([job({ triggers: [{ type: 'mail', match: [] }], nextRunAt: null })]).tasks
    expect(only).toMatchObject({ schedule: null, brain: null, record: { id: 't1', triggers: [{ type: 'mail' }] } })
  })

  it('carries an end: a time when every time that moved has one, a number of runs for a single job', () => {
    const [one] = plan([cron('0 8 * * 1-5', { end: { afterRuns: 10, at: '2026-12-31T00:00:00.000Z' }, runCount: 4 })]).tasks
    expect(one.schedule?.ends_at).toBe('2026-12-31T00:00:00.000Z')
    expect(one.record).toMatchObject({ end: { afterRuns: 10 }, runCount: 4 })
    const [two] = plan([cron('0 8 * * 1-5', { end: { afterRuns: 10, at: '2026-12-31T00:00:00.000Z' } }), cron('0 18 * * 1-5')]).tasks
    expect(two.schedule?.ends_at).toBeUndefined()
    expect(two.record?.end).toBeNull()
    expect(two.settings).toEqual(expect.arrayContaining(['an end time of one job is not carried over: the task\'s other times have none', 'a number of runs to end after is not carried over: the task has more than one time']))
  })

  it('a repeating time that came due before the migration is still seen: the cursor stands just before it', () => {
    const [t] = plan([cron('0 8 * * 1-5', { nextRunAt: '2026-11-26T07:00:00.000Z' }), cron('0 18 * * 1-5')]).tasks
    expect(t.record?.cursor).toBe('2026-11-26T06:59:59.999Z')
    // not for a paused schedule: nothing from the pause is made up
    expect(plan([cron('0 8 * * 1-5', { nextRunAt: '2026-11-26T07:00:00.000Z', paused: true })]).tasks[0].record?.cursor).toBe('2026-11-26T10:00:00.000Z')
  })

  it('a job without a task gets a task made for it; without a project of the brain it stays as it is; one that is over is dropped', () => {
    const loose = cron('0 8 * * 1-5', { taskId: null })
    const [t] = plan([loose], []).tasks
    expect(t).toMatchObject({ taskId: null, outcome: 'moved', title: 'Daily brief', create: { title: `routine-${loose.id}`, content: 'Write the brief.', scope: 'project.ops' } })
    // the new task has the prompt as its text: nothing is appended
    expect(t.brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [] })
    expect(t.record).toMatchObject({ id: '', taskId: '' })
    // the store's step gets the id of the task once it exists
    expect(stepOf(t, 'made-1')).toMatchObject({ jobIds: [loose.id], record: { id: 'made-1', taskId: 'made-1' } })
    expect(stepOf({ ...t, runs: [run(loose.id, 'r1')] }, 'made-1').runs[0].jobId).toBe('made-1')

    const self = once(AHEAD, { taskId: null })
    const [left] = plan([self], [], { routineTaskOf: () => null }).tasks
    expect(left).toMatchObject({ outcome: 'left', settles: [], record: null, brain: null })
    expect(left.why).toContain('no project of the brain')
    expect(plan([once(PAST, { taskId: null })], []).tasks[0]).toMatchObject({ outcome: 'dropped', why: 'its time has passed, it never ran and has no task' })
    expect(plan([cron('0 8 * * *', { taskId: null, endedAt: '2026-11-01T00:00:00.000Z' })], []).tasks[0]).toMatchObject({ outcome: 'dropped', why: 'it had ended and has no task' })
  })
})

describe('the report of the plan', () => {
  it('lists per task the times, the appended text, the journal, each job and the settings that move', () => {
    const daily = cron('0 8 * * 1-5', { notify: 'always' })
    const later = once(LATER, { name: 'Check: invoice', prompt: 'Look whether the invoice was paid.' })
    const theirs = cron('0 7 * * *', { taskId: 't2', name: 'Their job' })
    const p = plan([daily, once(AHEAD), later, theirs, cron('0 9 * * *', { spaceId: 'space-2' })], [task(), task('t2', {}, { assignee_ids: ['dominik'] })])
    const report = jobMigrationReport(p, { space: 'Main', at: '2026-11-26T10:00:00.000Z', dryRun: true })
    expect(report).toContain('# Schedules onto tasks — dry run')
    expect(report).toContain('Space: Main · 2026-11-26T10:00:00.000Z · nothing written.')
    expect(report).toContain('4 jobs on 2 tasks: 1 moved, 1 dropped, 0 left as they are. 1 job of other spaces wait for their space.')
    expect(report).toContain('## Task t1 (t1) — moved')
    expect(report).toContain('- Repeating times: 0 8 * * 1-5 (Europe/Berlin)')
    expect(report).toContain(`- Wake-up: ${AHEAD}, set by session sess-123 — "Look whether the reply came."`)
    expect(report).toContain('- That schedule is written to the task.')
    expect(report).toContain('- Appended to the task\'s text: "Every 0 8 * * 1-5: Write the brief."')
    expect(report).toContain(`- Journal: A later one-time run was set too, for ${LATER}`)
    expect(report).toContain(`- Job "Check: invoice" (${later.id.slice(0, 8)}): once at ${LATER} → not the task's wake-up`)
    expect(report).toContain('- On this machine: tells always; new sessions start in bp-ops;')
    expect(report).toContain('## Task t2 (t2) — dropped: the task is dominik\'s: its schedule is left to their cockpit, nothing is written')
    expect(jobMigrationReport(p, { space: 'Main', at: 'now', dryRun: false })).toContain('# Schedules onto tasks — run')
    expect(jobMigrationReport({ tasks: [], elsewhere: 0 }, { space: 'Main', at: 'now', dryRun: true })).toContain('Nothing to move.')
  })
})
