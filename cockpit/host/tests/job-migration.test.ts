import { describe, it, expect } from 'vitest'
import { changedMeanwhile, jobMigrationReport, leftoverNote, MIGRATED_AWAY, NOT_MOVED, NOT_REACHED, planJobMigration, scheduleAtSchema24, stepOf, type JobMigrationInput, type JobMigrationTask } from '../src/domain/job-migration.js'
import type { JobV1 } from '../src/domain/job-v1.js'
import type { JobRun } from '../src/domain/job.js'
import { everyParagraph, withParagraph } from '../src/domain/schedule-tool.js'
import { formatInZone } from '../src/domain/schedule.js'

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
  id, status: 'active', title: `task-${id}`, content: 'Keep the customer informed.', properties: { assignee_ids: ['member'], display_title: `Task ${id}`, ...properties }, ...patch,
})
const plan = (jobs: JobV1[], tasks: Array<JobMigrationTask | [string, null]> = [task()], patch: Partial<JobMigrationInput> = {}) => planJobMigration({
  jobs, runs: {}, keys: {}, space: { key: null, name: 'Main', shared: false }, me: 'member', now: NOW,
  tasks: Object.fromEntries(tasks.map((t) => (Array.isArray(t) ? t : [t.id, t]))),
  routineTaskOf: (j) => ({ title: `routine-${j.id}`, display_title: j.name, content: j.prompt, scope: 'project.ops', status: 'active', assignee_ids: ['member'] }),
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
  })

  it('a paragraph the schedule tool added is found in the text, and one the migration added is found by the tool: neither is written twice', () => {
    // the tool's side, written with stray white space around the cron and the prompt
    const byTool = withParagraph('Keep the customer informed.\n', everyParagraph(' 0 8 * * 1-5 ', ' Write the brief.\n'))!
    const [found] = plan([cron(' 0 8 * * 1-5 ', { prompt: 'Write the brief. ' })], [task('t1', { content: byTool })]).tasks
    expect(found.brain).toMatchObject({ content: null, appended: [] })
    expect(found.jobs[0].what).toContain('its prompt is in the task\'s text already')
    // the migration's side: what it appends is what the tool would append, so the tool has nothing to add
    const [added] = plan([cron(' 0 8 * * 1-5 ', { prompt: ' Write the brief.\n' })], [task('t1', { content: 'Keep the customer informed.\n\n' })]).tasks
    expect(added.brain?.content).toBe(byTool)
    expect(withParagraph(added.brain!.content, everyParagraph('0 8 * * 1-5', 'Write the brief.'))).toBeNull()
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

  it('a one-time job whose time has passed and that never ran is not dropped: it is the task\'s wake-up with its past time, and fires late; one that ran has nothing to carry', () => {
    const missed = once(PAST)
    const [t] = plan([missed]).tasks
    expect(t).toMatchObject({ outcome: 'moved', renamed: [missed.id], settles: [missed.id] })
    expect(t.schedule).toEqual({ at: PAST, why: 'Look whether the reply came.', by_session: 'sess-1234-abcd', time_zone: 'Europe/Berlin' })
    // the engine fires a wake-up whose time has come however long ago, unless it is the one it fired last
    expect(t.record).toMatchObject({ id: 't1', firedWake: null })
    expect(t.brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [] })
    expect(t.jobs[0]).toEqual({ id: missed.id, name: 'Check: reply', kind: 'moved', what: `once at ${PAST} → the task's wake-up, though its time has passed: it never ran, so it fires late, at the cockpit's next look; set by session sess-123; its prompt is the reason` })

    // a job still ahead is the task's wake-up: the past one's prompt goes into the journal, and the report says so
    const ahead = once(AHEAD, { name: 'Check: offer', prompt: 'Look whether the offer was signed.' })
    const [both] = plan([missed, ahead]).tasks
    expect(both.schedule).toMatchObject({ at: AHEAD, why: 'Look whether the offer was signed.' })
    expect(both.brain?.journal).toEqual([`A one-time run set for ${PAST} never ran, and the task has another wake-up (${AHEAD}); what it was to do is noted here: "Look whether the reply came."`])
    expect(both.jobs.find((j) => j.id === missed.id)).toMatchObject({ kind: 'lost', what: `once at ${PAST} → not the task's wake-up: its time has passed, it never ran, and the task gets its wake-up from "Check: offer"; its prompt is noted in the journal` })
    // two that never ran: the earlier one is the wake-up
    const older = once('2026-11-24T02:00:00.000Z', { name: 'Check: older', prompt: 'The older check.' })
    expect(plan([missed, older]).tasks[0].schedule).toMatchObject({ at: '2026-11-24T02:00:00.000Z', why: 'The older check.' })
    // without a task, one is made for it, as for any job that still has something to do
    expect(plan([once(PAST, { taskId: null, target: { type: 'worker', projectId: 'bp-ops' } })], []).tasks[0]).toMatchObject({ outcome: 'moved', create: { display_title: 'Check: reply' }, schedule: { at: PAST } })

    const ran = once(PAST, { runCount: 1 })
    const [u] = plan([ran], [task()], { runs: { [ran.id]: [run(ran.id, 'r1')] } }).tasks
    expect(u).toMatchObject({ brain: null, record: null, history: { [ran.id]: [{ id: 'r1', status: 'finished' }] } })
    expect(u.jobs[0]).toMatchObject({ kind: 'history', what: `once at ${PAST} → it has run: no time to carry over` })
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
    const other = plan([here, there], [task(), task('t2')], { space: { key: 'space-2', name: 'Team', shared: false } })
    expect(other.tasks.map((t) => [t.taskId, t.settles, t.record?.spaceId])).toEqual([['t2', [there.id], 'space-2']])
  })

  it('two jobs on one task with different reply modes: the stricter one wins, whichever job is older', () => {
    const mail = { type: 'mail' as const, match: [{ kind: 'domain', domain: 'customer.example' }] }
    const drafts = () => job({ triggers: [mail], reply: { mail: 'draft' } })
    const sends = () => job({ triggers: [mail], reply: { mail: 'send' } })
    expect(plan([drafts(), sends()]).tasks[0].record?.reply).toEqual({ mail: 'draft' })
    expect(plan([sends(), drafts()]).tasks[0].record?.reply).toEqual({ mail: 'draft' })
    // both send: nothing is made stricter than either was
    expect(plan([sends(), sends()]).tasks[0].record?.reply).toEqual({ mail: 'send' })
  })

  it('two jobs on one task: the record\'s tools are the narrowest of both, whichever is older, and a job without a profile widens nothing', () => {
    const narrow = { deniedTools: ['Bash'], mcpServers: [] as string[] }
    // the older job had all its tools, the newer one was narrowed: the task's sessions keep the narrow profile
    expect(plan([cron('0 8 * * *'), cron('0 18 * * *', { toolProfile: narrow })]).tasks[0].record?.toolProfile).toEqual(narrow)
    expect(plan([cron('0 8 * * *', { toolProfile: narrow }), cron('0 18 * * *')]).tasks[0].record?.toolProfile).toEqual(narrow)
    // two profiles: every denied tool of either, only the MCP servers both allow
    const [t] = plan([
      cron('0 8 * * *', { toolProfile: { deniedTools: ['Bash'], mcpServers: ['eml_brain', 'slack'] } }),
      cron('0 18 * * *', { toolProfile: { deniedTools: ['WebFetch'], mcpServers: ['eml_brain'] } }),
      once(AHEAD, { toolProfile: { deniedTools: ['Bash'], mcpServers: null } }),
    ]).tasks
    expect(t.record?.toolProfile).toEqual({ deniedTools: ['Bash', 'WebFetch'], mcpServers: ['eml_brain'] })
    expect(t.settings).toContain('its tool profile (the narrowest of its 3 jobs)')
    // none had one: none
    expect(plan([cron('0 8 * * *'), cron('0 18 * * *')]).tasks[0].record?.toolProfile).toBeNull()
  })

  it('two jobs on one task: who hears of a run is the loudest of them; new sessions start where the oldest job started them, and the report says so', () => {
    const told = (a: JobV1['notify'], b: JobV1['notify']) => plan([cron('0 8 * * *', { notify: a }), cron('0 18 * * *', { notify: b })]).tasks[0].record?.notify
    expect([told('never', 'needs-me'), told('needs-me', 'never'), told('never', 'always'), told('always', 'never'), told('needs-me', 'always'), told('never', 'never')])
      .toEqual(['needs-me', 'needs-me', 'always', 'always', 'always', 'never'])
    const [t] = plan([cron('0 8 * * *', { name: 'Morning', target: { type: 'worker', projectId: 'bp-ops' } }), cron('0 18 * * *', { name: 'Evening', target: { type: 'worker', projectId: 'bp-sales' } })]).tasks
    expect(t.record?.projectId).toBe('bp-ops')
    expect(t.settings).toContain('from its 2 jobs: new sessions start where the oldest one ("Morning") started them; the tools are the narrowest, a limit and draft replies hold if any had them, runs are told as the loudest of them said, lent tools and channels are those of all')
  })

  describe('whose jobs move where: one rule with the engine (domain/task-owner.ts firingOf)', () => {
    const shared: Partial<JobMigrationInput> = { space: { key: null, name: 'Team', shared: true }, members: ['member', 'other'] }
    const outcome = (t: JobMigrationTask, patch: Partial<JobMigrationInput> = shared) => plan([cron('0 8 * * 1-5')], [t], patch).tasks[0]

    it('moves the job of my task, with its record', () => {
      expect(outcome(task('t1', { ingested_by: 'other' }, { assignee_ids: ['member', 'other'] }))).toMatchObject({ outcome: 'moved', why: null, record: { id: 't1' } })
      expect(outcome(task('t1', { ingested_by: 'member' }, { assignee_ids: [] }))).toMatchObject({ outcome: 'moved', record: { id: 't1' } })
    })

    it('a live job on another member\'s task is not moved and nothing is written to the task: it ends here, and the report says loudly that it no longer fires and how its owner brings it back', () => {
      const j = cron('0 8 * * 1-5', { limited: true, toolProfile: { deniedTools: ['Bash'], mcpServers: null }, end: { afterRuns: 5 }, notify: 'always' })
      const theirs = task('t1', { ingested_by: 'member' }, { assignee_ids: ['other', 'member'], delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'], time_zone: 'Europe/Berlin' } } })
      const [t] = plan([j], [theirs], { ...shared, runs: { [j.id]: [run(j.id, 'r1', 'started')] } }).tasks
      expect(t).toMatchObject({ outcome: 'dropped', why: 'the task is other\'s: this cockpit does not fire it and writes nothing to it', brain: null, record: null, runs: [], renamed: [], settles: [j.id] })
      // the schedule the task has is its owner's: it stays as it is
      expect(t.schedule).toEqual({ crons: ['0 7 * * *'], time_zone: 'Europe/Berlin' })
      expect(t.jobs).toEqual([{
        id: j.id, name: 'Daily brief', kind: 'lost',
        what: 'NOT MOVED, IT NO LONGER FIRES: the task "Task t1" (t1) is other\'s, and this cockpit writes nothing to a task it does not fire. The job (cron "0 8 * * 1-5" (Europe/Berlin)) had the prompt "Write the brief." '
          + 'To bring it back, other sets the time on the task with the schedule tool: action "create", task_id "t1", cron "0 8 * * 1-5", timezone "Europe/Berlin", prompt "Write the brief."',
      }])
      // its open run ends here as history under the job's id
      expect(t.history[j.id]).toMatchObject([{ status: 'finished', note: MIGRATED_AWAY }])
      const report = jobMigrationReport({ tasks: [t], elsewhere: 0 }, { space: 'Team', at: 'now', dryRun: true })
      expect(report).toContain('## Task t1 (t1) — dropped: the task is other\'s: this cockpit does not fire it and writes nothing to it')
      expect(report).toContain(`- Job "Daily brief" (${j.id.slice(0, 8)}): NOT MOVED, IT NO LONGER FIRES: the task "Task t1" (t1) is other's`)
      expect(report).toContain('- The task\'s schedule stays as it is: 0 7 * * * (Europe/Berlin).')
    })

    it('on another member\'s task a one-time job names its time, a job a channel woke says so, and one that was over is history', () => {
      const theirs = task('t1', {}, { assignee_ids: ['other'] })
      const a = once(AHEAD)
      const b = job({ name: 'Mail', triggers: [{ type: 'mail', match: ['a@example.com'] } as never] })
      const c = cron('0 9 * * *', { endedAt: '2026-11-20T00:00:00.000Z' })
      const d = once(PAST, { runCount: 1 })
      const [t] = plan([a, b, c, d], [theirs], shared).tasks
      const what = Object.fromEntries(t.jobs.map((j) => [j.id, [j.kind, j.what]]))
      expect(what[a.id]).toEqual(['lost', `NOT MOVED, IT NO LONGER FIRES: the task "Task t1" (t1) is other's, and this cockpit writes nothing to a task it does not fire. The job (once at ${AHEAD}) had the prompt "Look whether the reply came." To bring it back, other sets the time on the task with the schedule tool: action "create", task_id "t1", at "${AHEAD}", timezone "Europe/Berlin", prompt "Look whether the reply came."`])
      expect(what[b.id]).toEqual(['lost', 'NOT MOVED, IT NO LONGER FIRES: the task "Task t1" (t1) is other\'s, and this cockpit writes nothing to a task it does not fire. The job (no time, woken by mail) had the prompt "Write the brief." To bring it back, other sets it up on the task on their own cockpit: a channel is kept per machine.'])
      expect(what[c.id]).toEqual(['history', 'had ended: its runs stay as history'])
      expect(what[d.id]).toEqual(['history', `once at ${PAST} → it has run: no time to carry over`])
      expect(t).toMatchObject({ outcome: 'dropped', brain: null, record: null, settles: [a.id, b.id, c.id, d.id] })
    })

    it('a task nobody is assigned to that another member authored is that member\'s', () => {
      expect(outcome(task('t1', { ingested_by: 'other' }, { assignee_ids: [] }))).toMatchObject({ outcome: 'dropped', brain: null, record: null, why: 'the task is other\'s: this cockpit does not fire it and writes nothing to it' })
    })

    it('in a shared space a task no member owns (nobody assigned, written by an agent or by nobody) is not moved onto, like another member\'s: nothing is written, and the report says how to take it', () => {
      for (const author of ['atlas', null]) {
        const t = outcome(task('t1', { ingested_by: author }, { assignee_ids: [] }))
        expect(t).toMatchObject({ outcome: 'dropped', why: 'nobody owns the task: this cockpit moves no job onto it and writes nothing to it', brain: null, record: null, settles: [expect.any(String)] })
        expect(t.jobs).toEqual([{
          id: expect.any(String), name: 'Daily brief', kind: 'lost',
          what: 'NOT MOVED, IT NO LONGER FIRES: nobody owns this task: "Task t1" (t1). The job (cron "0 8 * * 1-5" (Europe/Berlin)) had the prompt "Write the brief." '
            + 'To bring it back, assign the task to yourself and set its time with the schedule tool: action "create", task_id "t1", cron "0 8 * * 1-5", timezone "Europe/Berlin", prompt "Write the brief."',
        }])
      }
      // a channel alone, and a closed task no member owns: nothing is written either
      const mail = plan([job({ name: 'Mail', triggers: [{ type: 'mail', match: ['a@example.com'] } as never] })], [task('t1', { ingested_by: 'atlas' }, { assignee_ids: [] })], shared).tasks[0]
      expect(mail.jobs[0].what).toBe('NOT MOVED, IT NO LONGER FIRES: nobody owns this task: "Task t1" (t1). The job (no time, woken by mail) had the prompt "Write the brief." To bring it back, assign the task to yourself and set it up on it again on your cockpit: a channel is kept per machine.')
      const closed = outcome(task('t1', { ingested_by: 'atlas', status: 'resolved' }, { assignee_ids: [], delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'] } } }))
      expect(closed).toMatchObject({ outcome: 'dropped', brain: null, record: null, why: 'the task is closed (resolved) and nobody owns it: nothing is written' })
    })

    it('in a private space a task nobody is assigned to moves as this member\'s own', () => {
      const t = outcome(task('t1', { ingested_by: 'atlas' }, { assignee_ids: [] }), { space: { key: null, name: 'Main', shared: false } })
      expect(t).toMatchObject({ outcome: 'moved', why: null, record: { id: 't1', spaceId: null }, schedule: { crons: ['0 8 * * 1-5'] } })
    })

    it('plans nothing while it is not known whether the space is shared, or who its members are: the jobs wait', () => {
      const unassigned = task('t1', { ingested_by: 'atlas' }, { assignee_ids: [] })
      for (const patch of [{ space: { key: null, name: 'Team', shared: null } }, { space: { key: null, name: 'Team', shared: true }, members: null }] as Array<Partial<JobMigrationInput>>) {
        const t = outcome(unassigned, patch)
        expect(t).toMatchObject({ outcome: 'left', settles: [], brain: null, record: null })
      }
      expect(outcome(unassigned, { space: { key: null, name: 'Team', shared: null } }).why).toBe('the brain server has not said yet whether this space is shared: nothing is planned until it has')
      expect(outcome(unassigned, { space: { key: null, name: 'Team', shared: true }, members: null }).why).toBe('the members of this space could not be read, so it is not known whether a member owns the task: it waits')
      // my own task needs neither
      expect(outcome(task('t1', {}, { assignee_ids: ['member'] }), { space: { key: null, name: 'Team', shared: true }, members: null }).outcome).toBe('moved')
      // and with the kind unknown not even that one is planned
      expect(outcome(task('t1', {}, { assignee_ids: ['member'] }), { space: { key: null, name: 'Team', shared: null } }).outcome).toBe('left')
    })

    it('a closed task of another member is dropped and nothing is written to it', () => {
      const t = outcome(task('t1', { status: 'resolved' }, { assignee_ids: ['other'], delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'] } } }))
      expect(t).toMatchObject({ outcome: 'dropped', brain: null, record: null, why: 'the task is closed (resolved) and other\'s: nothing is written' })
    })

    it('moves every task\'s jobs in a local space: each task there is this member\'s', () => {
      const local = { space: { key: null, name: 'Main', shared: false } }
      expect(outcome(task('t1', { ingested_by: 'other' }, { assignee_ids: ['other'] }), local)).toMatchObject({ outcome: 'moved', record: { id: 't1' } })
      expect(outcome(task('t1', {}, { assignee_ids: [] }), local)).toMatchObject({ outcome: 'moved', record: { id: 't1' } })
    })
  })

  describe('a schedule the old mirror left on a task without a job', () => {
    const leftover = (id: string, patch: Partial<JobMigrationTask> = {}, properties: JobMigrationTask['properties'] = {}) =>
      task(id, patch, { delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } }, ...properties })

    it('is removed in the pass that moves the jobs: nothing ran it before, so nothing may start to', () => {
      const j = cron('0 8 * * 1-5')
      const stale = leftover('t2')
      const p = plan([j, cron('0 9 * * *', { taskId: 't3', endedAt: '2026-11-20T00:00:00.000Z' })], [task(), leftover('t3')], { scheduled: [stale, leftover('t1'), leftover('t3'), leftover('t4')], records: new Set(['t4']) })
      // t1 has a live job and t3 an ended one: they are planned as tasks. t4 has a record: someone set its schedule here since.
      expect(p.leftovers).toEqual([{ taskId: 't2', title: 'Task t2', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } }])
      const report = jobMigrationReport(p, { space: 'Main', at: 'now', dryRun: false })
      expect(report).toContain('## Task t2 (t2) — a schedule without a job')
      expect(report).toContain('- A schedule without a job was left on this task (0 7 * * * (UTC)); removed.')
      expect(report).toContain('1 schedule without a job was left on a task.')
    })

    it('is never looked for in a later pass, and never on a task of another member or one this cockpit does not fire', () => {
      const j = cron('0 8 * * 1-5')
      // not the first pass of the space: no list of scheduled tasks is given
      expect(plan([j], [task()]).leftovers).toEqual([])
      const shared: Partial<JobMigrationInput> = { space: { key: null, name: 'Team', shared: true }, members: ['member', 'other'] }
      const theirs = leftover('t2', {}, { assignee_ids: ['other'] })
      const agents = leftover('t3', { ingested_by: 'atlas' }, { assignee_ids: [] })
      expect(plan([j], [task()], { ...shared, scheduled: [theirs, agents], records: new Set() }).leftovers).toEqual([])
      // a closed task is not among the scheduled ones the pass lists; one given all the same is left alone
      expect(plan([j], [task()], { scheduled: [leftover('t2', { status: 'resolved' })], records: new Set() }).leftovers).toEqual([])
    })

    it('is judged the same way in a shared space: a task this cockpit fires loses it; a task it does not fire is not touched and not named', () => {
      const j = cron('0 8 * * 1-5')
      const shared: Partial<JobMigrationInput> = { space: { key: null, name: 'Team', shared: true }, members: ['member', 'other'] }
      const p = plan([j], [task()], { ...shared, scheduled: [leftover('t2'), leftover('t3', {}, { assignee_ids: ['other'] }), leftover('t4', { ingested_by: 'atlas' }, { assignee_ids: [] })], records: new Set() })
      expect(p.leftovers).toEqual([{ taskId: 't2', title: 'Task t2', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' }, shared: true }])
      // the other member's old cockpit may have run it: the report claims only what this cockpit knows
      const report = jobMigrationReport(p, { space: 'Team', at: 'now', dryRun: false })
      expect(report).toContain('- A schedule without a job was left on this task (0 7 * * * (UTC)). No job on this cockpit ran it; it is removed so nothing starts to run it now.')
      expect(leftoverNote({ crons: ['0 7 * * *'], time_zone: 'UTC' }, true)).toBe('A schedule without a job was left on this task (0 7 * * * (UTC)) from before schedules moved onto tasks. No job on this cockpit ran it; it is removed so nothing starts to run it now. Set a new time if the task should run at one.')
      expect(leftoverNote({ crons: ['0 7 * * *'], time_zone: 'UTC' }, false)).toContain('Nothing ran it then')
      expect(report).not.toContain('t3')
      expect(report).not.toContain('In a shared space')
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

    // a paused repeating job next to running ones: its time is not left out. The pause wins: the whole schedule is
    // paused, with every repeating time on it, and the journal and the report say why and how to resume
    const sleeping = cron('0 18 * * 1-5', { name: 'Evening brief', prompt: 'Write the evening brief.', paused: true, pausedReason: '3 failed runs in a row; last: run 9 failed' })
    const [mixed] = plan([cron('0 8 * * 1-5'), sleeping, once(AHEAD)]).tasks
    expect(mixed.schedule).toEqual({ crons: ['0 18 * * 1-5', '0 8 * * 1-5'], at: AHEAD, why: 'Look whether the reply came.', by_session: 'sess-1234-abcd', time_zone: 'Europe/Berlin', paused: true })
    expect(mixed.brain?.journal.at(-1)).toBe('Its schedule is paused as a whole: its repeating job "Evening brief" (cron "0 18 * * 1-5") was paused when schedules moved onto tasks, and a task has one Pause for all its times. Nothing fires until it is resumed: Resume in the task\'s Schedule section, or the schedule tool\'s resume. To keep that one time off, remove it there first.')
    expect(mixed.jobs.find((j) => j.id === sleeping.id)?.what).toBe('cron "0 18 * * 1-5" (Europe/Berlin) → a repeating time of the task; it was paused, so the task\'s whole schedule is paused; its prompt is appended to the task\'s text')
    expect(mixed.record?.pausedReason).toBe('3 failed runs in a row; last: run 9 failed')
    expect(jobMigrationReport({ tasks: [mixed], elsewhere: 0 }, { space: 'Main', at: 'now', dryRun: true })).toContain('- The schedule is paused: one of its repeating jobs was. Resume it on the task (its Schedule section, or the schedule tool\'s resume).')
    // nothing of the pause is made up: the record starts from now
    expect(plan([cron('0 8 * * 1-5', { nextRunAt: '2026-11-26T07:00:00.000Z' }), sleeping]).tasks[0].record?.cursor).toBe('2026-11-26T10:00:00.000Z')

    // a paused one-time job next to running ones is left out, and noted
    const nap = once(AHEAD, { paused: true })
    const [one] = plan([cron('0 8 * * 1-5'), nap]).tasks
    expect(one.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(one.jobs.find((j) => j.id === nap.id)).toMatchObject({ kind: 'lost', what: `once at ${AHEAD} → left out: it was paused while the task's other times run; noted in the journal` })
    expect(one.brain?.journal.at(-1)).toContain('A paused one-time run was not carried over')
    expect(one.settles).toContain(nap.id)
  })

  it('a task\'s repeating times are read in one zone: a job in another zone is left out, and the journal and the report say loudly that it no longer fires and how to bring it back', () => {
    const berlin = cron('0 8 * * 1-5')
    const tokyo = job({ name: 'Tokyo brief', prompt: 'Write the Tokyo brief.', triggers: [{ type: 'schedule', cron: '0 9 * * *', timeZone: 'Asia/Tokyo' }] })
    const [t] = plan([tokyo, berlin]).tasks
    expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(t.brain?.journal.at(-1)).toBe(
      'The routine "Tokyo brief" NO LONGER FIRES: it ran in another time zone (cron "0 9 * * *", Asia/Tokyo) than the task\'s repeating times (Europe/Berlin), and a task\'s times are read in one zone, so it was not carried over when schedules moved onto tasks. '
      + 'To bring it back on a task of its own, call the schedule tool: action "create", name "Tokyo brief", cron "0 9 * * *", timezone "Asia/Tokyo", prompt "Write the Tokyo brief."',
    )
    expect(t.jobs[1]).toEqual({
      id: tokyo.id, name: 'Tokyo brief', kind: 'lost',
      what: 'cron "0 9 * * *" (Asia/Tokyo) → NOT MOVED, IT NO LONGER FIRES: the task\'s repeating times are read in Europe/Berlin, and a task has one zone. To bring it back on a task of its own, call the schedule tool: action "create", name "Tokyo brief", cron "0 9 * * *", timezone "Asia/Tokyo", prompt "Write the Tokyo brief."',
    })
    // the report gives the call whole, not cut
    const report = jobMigrationReport({ tasks: [t], elsewhere: 0 }, { space: 'Main', at: 'now', dryRun: false })
    expect(report).toContain('timezone "Asia/Tokyo", prompt "Write the Tokyo brief."')
    expect(report).toContain('2 jobs on 1 task: 1 moved, 0 dropped, 0 left as they are. Of the jobs, 1 moved and 1 did not.')
  })

  it('a task whose whole text is the job\'s prompt (a routine task made from the job earlier) does not get it a second time', () => {
    const [t] = plan([cron('0 8 * * 1-5', { prompt: ' Write the brief.\n' })], [task('t1', { content: 'Write the brief.\n' })]).tasks
    expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' })
    expect(t.brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [] })
    expect(t.jobs[0].what).toContain('its prompt is in the task\'s text already')
    // a second job with another prompt still gets its paragraph
    const [two] = plan([cron('0 8 * * 1-5'), cron('0 18 * * 1-5', { prompt: 'Sum the day up.' })], [task('t1', { content: 'Write the brief.' })]).tasks
    expect(two.brain).toMatchObject({ content: 'Write the brief.\n\nEvery 0 18 * * 1-5: Sum the day up.', appended: ['Every 0 18 * * 1-5: Sum the day up.'] })
  })

  it('a prompt the task\'s text says already is not appended: the whole paragraph the migration would add, or a prompt a scheduled hand-over built from the task', () => {
    const said = task('t1', { content: 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.' })
    expect(plan([cron('0 8 * * 1-5')], [said]).tasks[0].brain).toEqual({ setSchedule: true, content: null, appended: [], journal: [] })
    // the bare prompt somewhere in the text is not that paragraph: a short prompt such as "Continue" is not taken as said
    const short = plan([cron('0 8 * * 1-5', { prompt: 'Continue' })], [task('t1', { content: 'Continue reading the docs, then write the brief.' })]).tasks[0]
    expect(short.brain).toMatchObject({ appended: ['Every 0 8 * * 1-5: Continue'], content: 'Continue reading the docs, then write the brief.\n\nEvery 0 8 * * 1-5: Continue' })
    expect(plan([cron('0 8 * * 1-5')], [task('t1', { content: 'Every morning: Write the brief. Then send it.' })]).tasks[0].brain?.appended).toEqual(['Every 0 8 * * 1-5: Write the brief.'])
    const built = cron('0 8 * * 1-5', { prompt: 'A scheduled job started you for "task-t1" (task t1).\nKeep the customer informed.\n\nNo checkpoint: do this run to the end on your own; ask only when you cannot go on.' })
    const [t] = plan([built]).tasks
    expect(t.brain).toMatchObject({ content: null, appended: [] })
    expect(t.jobs[0].what).toContain('its prompt is in the task\'s text already')
    // a task without text gets the paragraph as its text
    expect(plan([cron('0 8 * * 1-5')], [task('t1', { content: '' })]).tasks[0].brain?.content).toBe('Every 0 8 * * 1-5: Write the brief.')
  })

  it('a one-time job whose prompt is longer than a wake-up\'s reason holds loses nothing: the whole prompt is its own paragraph of the task\'s text, and the reason points to it', () => {
    const long = `Check the three invoices. ${'Then look at the next one. '.repeat(90)}The last word is zebra.`
    expect(long.length).toBeGreaterThan(2000)
    const when = `${formatInZone(Date.parse(AHEAD), 'Europe/Berlin')} (Europe/Berlin)`
    const [t] = plan([once(AHEAD, { prompt: long })]).tasks
    expect(t.schedule).toMatchObject({ at: AHEAD, why: `See the task's text: the paragraph that starts 'At ${when}'.` })
    expect(t.brain).toMatchObject({ appended: [`At ${when}: ${long}`], content: `Keep the customer informed.\n\nAt ${when}: ${long}` })
    expect(t.brain!.content!.endsWith('The last word is zebra.')).toBe(true)
    expect(t.brain!.journal).toEqual(['Schedules moved onto tasks: what its one-time job was to do is longer than a wake-up\'s reason holds, so it was added to the task\'s text in full, as "At <time>: …".'])
    expect(t.jobs[0].what).toBe(`once at ${AHEAD} → the task's wake-up, set by session sess-123; its prompt is longer than a wake-up's reason holds (2000 characters): it is appended to the task's text in full, and the reason points to it`)
    // planned again against what it wrote: nothing more
    const again = plan([once(AHEAD, { prompt: long })], [task('t1', { content: t.brain!.content! }, { delegation: { agent: 'atlas', schedule: t.schedule! } })]).tasks[0]
    expect(again.brain).toBeNull()
    // a prompt that fits is the reason itself, as before
    expect(plan([once(AHEAD)]).tasks[0]).toMatchObject({ schedule: { why: 'Look whether the reply came.' }, brain: { appended: [] } })
  })

  it('a job\'s goal is carried: it becomes the task\'s goal when the task has none; a task that has one keeps it, and the journal quotes the job\'s', () => {
    const j = cron('0 8 * * 1-5', { goal: 'The customer hears from us every morning.', createdAt: '2026-11-01T00:00:00.000Z' })
    const [none] = plan([j]).tasks
    expect(none.brain).toMatchObject({ goal: 'The customer hears from us every morning.' })
    expect(none.brain!.journal.join(' ')).not.toContain('goal')
    expect(jobMigrationReport({ tasks: [none], elsewhere: 0 }, { space: 'Main', at: 'now', dryRun: true })).toContain('- The task gets the goal of job "Daily brief": "The customer hears from us every morning."')
    const [has] = plan([j], [task('t1', {}, { goal: 'Keep the customer.' })]).tasks
    expect(has.brain!.goal).toBeUndefined()
    expect(has.brain!.journal).toContain('The job "Daily brief" had a goal of its own when schedules moved onto tasks; the task keeps its goal, so the job\'s is noted here: "The customer hears from us every morning."')
    // two jobs with a goal: the older one's is the task's, the other's is quoted
    const second = cron('0 9 * * *', { name: 'Second', goal: 'Nothing is left open.', createdAt: '2026-11-02T00:00:00.000Z' })
    const [two] = plan([j, second]).tasks
    expect(two.brain).toMatchObject({ goal: 'The customer hears from us every morning.' })
    expect(two.brain!.journal).toContain('The job "Second" had a goal of its own when schedules moved onto tasks; the task keeps its goal, so the job\'s is noted here: "Nothing is left open."')
    // a goal alone is a reason to write the task
    const mirrored = task('t1', { content: 'Keep the customer informed.\n\nEvery 0 8 * * 1-5: Write the brief.' }, { delegation: { agent: 'atlas', schedule: { crons: ['0 8 * * 1-5'], time_zone: 'Europe/Berlin' } } })
    expect(plan([j], [mirrored]).tasks[0].brain).toEqual({ setSchedule: false, content: null, appended: [], journal: [], goal: 'The customer hears from us every morning.', goalOf: 'Daily brief' })
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
    expect(t.settings).toEqual(expect.arrayContaining(['tells needs-me', 'limited, lent chrome', 'its tool profile (the narrowest of its 2 jobs)', 'wakes on mail (1 sender), waiting for the user\'s OK', 'mail replies: draft', 'new sessions start in bp-customer with codex']))
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

  describe('an open run of version 1 that never reached a session', () => {
    const unreached = (jobId: string, id: string, status: 'waiting' | 'starting'): JobRun => ({ ...run(jobId, id, status, 1), dueAt: PAST, sessionId: null, startedAt: null, finishedAt: null })

    it('a one-time job whose run waits or was starting has not run: it is the task\'s wake-up with its prompt and session, its run is closed, and the report never says it has run', () => {
      for (const status of ['waiting', 'starting'] as const) {
        const check = once(PAST, { runCount: 1 })
        const [t] = plan([check], [task()], { runs: { [check.id]: [unreached(check.id, 'r1', status)] } }).tasks
        expect(t).toMatchObject({ outcome: 'moved', settles: [check.id] })
        expect(t.schedule).toEqual({ at: PAST, why: 'Look whether the reply came.', by_session: 'sess-1234-abcd', time_zone: 'Europe/Berlin' })
        // no bare run is carried: the wake-up fires once, through the engine's own path
        expect(t.runs.filter((r) => r.status === 'waiting' || r.status === 'starting')).toEqual([])
        expect(t.record).toMatchObject({ id: 't1', firedWake: null, runCount: 0 })
        expect(t.history[check.id]).toMatchObject([{ id: 'r1', status: 'skipped', note: NOT_REACHED }])
        expect(t.jobs[0]).toMatchObject({ kind: 'moved', what: expect.stringContaining('the task\'s wake-up, though its time has passed: it never ran') })
        const report = jobMigrationReport(plan([check], [task()], { runs: { [check.id]: [unreached(check.id, 'r1', status)] } }), { space: 'Main', at: 'now', dryRun: true })
        expect(report).not.toContain('it has run')
        expect(report).toContain('- Wake-up: 2026-11-25T02:00:00.000Z, set by session sess-123 — "Look whether the reply came."')
      }
      // one that ran before its open run (its count says so) has run
      const ran = once(PAST, { runCount: 2 })
      expect(plan([ran], [task()], { runs: { [ran.id]: [unreached(ran.id, 'r1', 'waiting')] } }).tasks[0].jobs[0]).toMatchObject({ kind: 'history' })
    })

    it('a repeating job\'s run that waits is carried, and says which time fired: its due time as a firing of the job\'s cron', () => {
      const daily = cron('0 8 * * 1-5', { runCount: 1, target: { type: 'session', sessionId: 'sess-1234-abcd' } })
      // due within the engine's late limit (a time older than that is missed, not carried)
      const dueAt = '2026-11-26T07:00:00.000Z'
      const [t] = plan([daily], [task()], { runs: { [daily.id]: [{ ...unreached(daily.id, 'r1', 'waiting'), dueAt }] } }).tasks
      expect(t.runs).toMatchObject([{ id: 'r1', jobId: 't1', status: 'waiting', fired: { crons: [{ cron: '0 8 * * 1-5', dueAt }], timeZone: 'Europe/Berlin' } }])
      // the job's prompt is in the task's text, where a new session of the task reads it
      expect(t.brain?.appended).toEqual(['Every 0 8 * * 1-5: Write the brief.'])
    })

    it('a repeating job that is left out does not carry its run: it is settled as history under the job\'s id, and its cron is not on the task', () => {
      const first = job({ triggers: [{ type: 'schedule', cron: '0 8 * * 1-5', timeZone: 'Asia/Makassar' }] })
      const berlin = cron('0 9 * * 1-5', { name: 'Berlin brief', runCount: 1 })
      const [t] = plan([first, berlin], [task()], { runs: { [berlin.id]: [unreached(berlin.id, 'r1', 'waiting')] } }).tasks
      expect(t.schedule).toEqual({ crons: ['0 8 * * 1-5'], time_zone: 'Asia/Makassar' })
      expect(t.jobs.find((j) => j.id === berlin.id)).toMatchObject({ kind: 'lost' })
      expect(t.runs).toEqual([])
      expect(t.history[berlin.id]).toMatchObject([{ id: 'r1', jobId: berlin.id, status: 'skipped', note: NOT_MOVED }])
      // its run is no run of the task: the record's count holds none of it
      expect(t.record).toMatchObject({ id: 't1', runCount: 0 })
      // the same past the limit of repeating times
      const many = Array.from({ length: 10 }, (_, i) => cron(`0 ${i} * * *`))
      const over = cron('0 23 * * *', { runCount: 1 })
      const [full] = plan([...many, over], [task()], { runs: { [over.id]: [unreached(over.id, 'r2', 'starting')] } }).tasks
      expect(full.runs).toEqual([])
      expect(full.history[over.id]).toMatchObject([{ id: 'r2', status: 'skipped', note: NOT_MOVED }])
    })
  })

  it('a job that waited for the user\'s OK never fired in version 1: its time is not overdue, and its hold is the record\'s', () => {
    const held = cron('0 9 * * *', { pendingApproval: true, nextRunAt: '2026-11-26T08:00:00.000Z' })
    const [t] = plan([cron('0 13 * * 1-5', { nextRunAt: '2026-11-26T12:00:00.000Z' }), held]).tasks
    expect(t.record).toMatchObject({ cursor: '2026-11-26T10:00:00.000Z', pendingApproval: true })
    // a paused one is not overdue either (and pauses the whole schedule)
    expect(plan([cron('0 13 * * 1-5'), cron('0 9 * * *', { paused: true, nextRunAt: '2026-11-26T08:00:00.000Z' })]).tasks[0].record?.cursor).toBe('2026-11-26T10:00:00.000Z')
    // a time that is due and not held still is
    expect(plan([cron('0 9 * * *', { nextRunAt: '2026-11-26T08:00:00.000Z' }), held]).tasks[0].record?.cursor).toBe('2026-11-26T07:59:59.999Z')
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
    // a one-time job that ran and has no task has nothing left to do
    const done = once(PAST, { taskId: null, runCount: 1 })
    expect(plan([done], [], { runs: { [done.id]: [run(done.id, 'r1')] } }).tasks[0]).toMatchObject({ outcome: 'dropped', why: 'it has run and has no task' })
    expect(plan([cron('0 8 * * *', { taskId: null, endedAt: '2026-11-01T00:00:00.000Z' })], []).tasks[0]).toMatchObject({ outcome: 'dropped', why: 'it had ended and has no task' })
  })
})

describe('the report of the plan', () => {
  it('lists per task the times, the appended text, the journal, each job and the settings that move', () => {
    const daily = cron('0 8 * * 1-5', { notify: 'always' })
    const later = once(LATER, { name: 'Check: invoice', prompt: 'Look whether the invoice was paid.' })
    const theirs = cron('0 7 * * *', { taskId: 't2', name: 'Their job' })
    const p = plan([daily, once(AHEAD), later, theirs, cron('0 9 * * *', { spaceId: 'space-2' })], [task(), task('t2', {}, { assignee_ids: ['other'] })], { space: { key: null, name: 'Main', shared: true }, members: ['member', 'other'] })
    const report = jobMigrationReport(p, { space: 'Main', at: '2026-11-26T10:00:00.000Z', dryRun: true })
    expect(report).toContain('# Schedules onto tasks — dry run')
    expect(report).toContain('Space: Main · 2026-11-26T10:00:00.000Z · nothing written.')
    expect(report).toContain('4 jobs on 2 tasks: 1 moved, 1 dropped, 0 left as they are. Of the jobs, 2 moved and 2 did not. 1 job of other spaces wait for their space.')
    expect(report).toContain('## Task t1 (t1) — moved')
    expect(report).toContain('- Repeating times: 0 8 * * 1-5 (Europe/Berlin)')
    expect(report).toContain(`- Wake-up: ${AHEAD}, set by session sess-123 — "Look whether the reply came."`)
    expect(report).toContain('- That schedule is written to the task.')
    expect(report).toContain('- Appended to the task\'s text: "Every 0 8 * * 1-5: Write the brief."')
    expect(report).toContain(`- Journal: A later one-time run was set too, for ${LATER}`)
    expect(report).toContain(`- Job "Check: invoice" (${later.id.slice(0, 8)}): once at ${LATER} → not the task's wake-up`)
    expect(report).toContain('- On this machine: tells always; new sessions start in bp-ops;')
    expect(report).toContain('## Task t2 (t2) — dropped: the task is other\'s: this cockpit does not fire it and writes nothing to it')
    expect(report).toContain(`- Job "Their job" (${theirs.id.slice(0, 8)}): NOT MOVED, IT NO LONGER FIRES: the task "Task t2" (t2) is other's`)
    expect(jobMigrationReport(p, { space: 'Main', at: 'now', dryRun: false })).toContain('# Schedules onto tasks — run')
    expect(jobMigrationReport({ tasks: [], elsewhere: 0 }, { space: 'Main', at: 'now', dryRun: true })).toContain('Nothing to move.')
  })
})

describe('a stored schedule read as schema 24 holds it', () => {
  it('a schema 23 schedule becomes what the brain\'s step to 24 leaves: the cron a list of one, at, time_zone and paused kept, the session gone', () => {
    expect(scheduleAtSchema24({ cron: ' 0 7 * * * ', time_zone: 'UTC', session: 'new', paused: true })).toEqual({ crons: ['0 7 * * *'], time_zone: 'UTC', paused: true })
    expect(scheduleAtSchema24({ at: AHEAD, session: 'resume', time_zone: ' ' })).toEqual({ at: AHEAD })
    // neither a cron nor a time: no schedule
    expect(scheduleAtSchema24({ cron: ' ', session: 'new' })).toBeNull()
  })

  it('a schedule in the new shape is returned as it is, and nothing is no schedule', () => {
    const now = { crons: ['0 7 * * *', '0 9 * * *'], at: AHEAD, why: 'Look.', by_session: 's1', time_zone: 'UTC', ends_at: LATER }
    expect(scheduleAtSchema24(now)).toBe(now)
    expect([scheduleAtSchema24(null), scheduleAtSchema24(undefined), scheduleAtSchema24('x')]).toEqual([null, null, null])
  })
})

describe('a planned task whose write found the task changed', () => {
  it('holds nothing of its plan: it is left, its live jobs wait in the version 1 data, and the report says so; a job that was over stays history', () => {
    const live = cron('0 8 * * 1-5')
    const over = cron('0 9 * * *', { endedAt: '2026-11-20T00:00:00.000Z' })
    const p = plan([live, over])
    const left = changedMeanwhile(p.tasks[0])
    expect(left).toMatchObject({ outcome: 'left', brain: null, record: null, settles: [], renamed: [], runs: [], settings: [], why: 'the task changed while its jobs were planned: nothing is written in this pass, and it is planned again at the next one' })
    expect(left.jobs).toEqual([
      { id: over.id, name: 'Daily brief', what: 'had ended: its runs stay as history', kind: 'history' },
      { id: live.id, name: 'Daily brief', what: 'waits: its task changed while it was planned', kind: 'waits' },
    ])
    const report = jobMigrationReport({ tasks: [left], elsewhere: 0 }, { space: 'Main', at: 'now', dryRun: false })
    expect(report).toContain('2 jobs on 1 task: 0 moved, 0 dropped, 1 left as they are. Of the jobs, 0 moved and 1 did not.')
    expect(report).not.toContain('Appended')
  })

  it('a left-over schedule the writer found changed is reported as left alone', () => {
    const report = jobMigrationReport({ tasks: [], elsewhere: 0, leftovers: [{ taskId: 't2', title: 'Task t2', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' }, changed: true }] }, { space: 'Main', at: 'now', dryRun: false })
    expect(report).toContain('- A schedule without a job was left on this task (0 7 * * * (UTC)); changed meanwhile, left alone.')
  })
})
