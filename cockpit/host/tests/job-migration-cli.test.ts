import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runMigrateJobsCommand, type MigrateJobsHome } from '../src/job-migration-cli.js'

// `eml-cockpit migrate-jobs`: the dry run by hand. It reads a home's jobs.json and brain files and prints what the
// host would do at its next start; it writes nothing.

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3') as new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): unknown }; close(): void }

const job = (id: string, patch: Record<string, unknown> = {}) => ({
  id, name: 'Daily brief', kind: 'routine', spaceId: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', taskId: 't1',
  prompt: 'Write the brief.', target: { type: 'worker', projectId: 'bp-ops' }, triggers: [{ type: 'schedule', cron: '0 8 * * 1-5', timeZone: 'UTC' }],
  toolProfile: null, reply: {}, end: null, notify: 'needs-me', paused: false, pausedReason: null, endedAt: null, nextRunAt: null, runCount: 0, failures: 0, ...patch,
})

type TaskRow = { id: string; status?: string; content?: string; properties?: Record<string, unknown> }

/** A home in a folder of its own: a jobs.json when `jobs` is given, and a brain file per space with these tasks. */
function homeWith(opts: { jobs?: unknown; tasks?: TaskRow[]; spaces?: Array<{ token: string; name?: string }>; config?: boolean; schema?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-migrate-jobs-'))
  const jobsFile = join(dir, 'jobs.json')
  if (opts.jobs !== undefined) writeFileSync(jobsFile, JSON.stringify(opts.jobs))
  const brainFile = join(dir, 'main.db')
  const db = new Database(brainFile)
  db.exec('CREATE TABLE engrams (id TEXT PRIMARY KEY, type TEXT, status TEXT, title TEXT, content TEXT, properties TEXT, ingested_by TEXT)')
  for (const t of opts.tasks ?? []) db.prepare('INSERT INTO engrams VALUES (?, ?, ?, ?, ?, ?, ?)').run(t.id, 'task', t.status ?? 'active', `task-${t.id}`, t.content ?? 'Keep the customer informed.', JSON.stringify({ assignee_ids: ['owner'], display_title: `Task ${t.id}`, ...t.properties }), 'owner')
  db.close()
  const home: MigrateJobsHome = {
    dir, jobsFile,
    config: async () => (opts.config === false ? null : { token: 'main-token', handle: 'owner', mainName: 'Main', spaces: opts.spaces ?? [] }),
    brainOf: (token) => (token === 'main-token' ? { brainId: 'main-brain', brainFile, schemaVersion: opts.schema ?? 25 } : token === 'team-token' ? { brainId: 'space-2', brainFile, schemaVersion: 25 } : { brainId: null, brainFile: null, schemaVersion: null }),
  }
  const printed: string[] = []
  return { dir, jobsFile, home, printed, run: (argv: string[] = ['migrate-jobs']) => runMigrateJobsCommand(argv, (text) => printed.push(text), home) }
}

describe('eml-cockpit migrate-jobs', () => {
  it('is not this command for any other word: nothing is read or printed', async () => {
    const h = homeWith({ config: false })
    expect(await h.run(['diagnose'])).toBe(false)
    expect(await h.run([])).toBe(false)
    expect(h.printed).toEqual([])
  })

  it('refuses --run: the host writes the migration at its start', async () => {
    const h = homeWith({ jobs: { version: 1, jobs: { j1: job('j1') }, runs: {}, keys: {} } })
    await expect(h.run(['migrate-jobs', '--run'])).rejects.toThrow('migrate-jobs is the dry run only: the host writes the migration at its start')
    expect(h.printed).toEqual([])
  })

  it('refuses a home that is not set up', async () => {
    const h = homeWith({ config: false })
    await expect(h.run()).rejects.toThrow(`no cockpit config in ${h.dir}: this home is not set up`)
  })

  it('has nothing to move in a home without a jobs.json, and in one whose jobs.json holds no version 1 jobs', async () => {
    const none = homeWith()
    expect(await none.run()).toBe(true)
    expect(none.printed).toEqual([`no jobs.json in ${none.dir}: nothing to move\n`])
    expect(existsSync(none.jobsFile)).toBe(false)
    const moved = homeWith({ jobs: { version: 2, timeZone: null, jobs: { t1: { id: 't1', runCount: 0 } }, runs: {}, keys: {} } })
    expect(await moved.run()).toBe(true)
    expect(moved.printed).toEqual(['jobs.json holds no version 1 jobs: nothing to move\n'])
  })

  it('says what it found when jobs.json cannot be parsed or has an unknown version, and writes or renames nothing', async () => {
    const cut = homeWith()
    writeFileSync(cut.jobsFile, '{"version": 1, "jobs": {"j1": {"id": "j1", "name": "Daily br')
    expect(await cut.run()).toBe(true)
    expect(cut.printed).toEqual([`jobs.json in ${cut.dir} cannot be read (it is not valid JSON, or the file cannot be opened): nothing is planned. The host sets it aside at its start, as jobs.json.unreadable-<UTC stamp>, and starts without the schedules it held.\n`])
    expect(readFileSync(cut.jobsFile, 'utf8')).toBe('{"version": 1, "jobs": {"j1": {"id": "j1", "name": "Daily br')
    expect(readdirSync(cut.dir).sort()).toEqual(['jobs.json', 'main.db'])

    const newer = homeWith({ jobs: { version: 3, jobs: { t1: { id: 't1' } }, runs: {}, keys: {} } })
    const before = readFileSync(newer.jobsFile, 'utf8')
    expect(await newer.run()).toBe(true)
    expect(newer.printed).toEqual([`jobs.json in ${newer.dir} has a version this cockpit does not know (neither 1 nor 2; a newer cockpit may have written it): nothing is planned. The host sets it aside at its start, as jobs.json.unknown-version-<UTC stamp>, and starts without the schedules it held.\n`])
    expect(readFileSync(newer.jobsFile, 'utf8')).toBe(before)
    expect(readdirSync(newer.dir).sort()).toEqual(['jobs.json', 'main.db'])
  })

  it('plans the main space from its brain file and prints the report; jobs.json is left byte for byte, with no backup', async () => {
    const h = homeWith({ jobs: { version: 1, timeZone: 'UTC', jobs: { j1: job('j1') }, runs: {}, keys: {} }, tasks: [{ id: 't1' }] })
    const before = readFileSync(h.jobsFile, 'utf8')
    expect(await h.run()).toBe(true)
    const text = h.printed.join('')
    expect(text.startsWith(`Dry run on ${h.dir} as owner: nothing is written.\n\n# Schedules onto tasks — dry run\n`)).toBe(true)
    expect(text).toContain('## Task t1 (t1) — moved')
    expect(text).toContain('- Repeating times: 0 8 * * 1-5 (UTC)')
    expect(text).toContain('- Appended to the task\'s text: "Every 0 8 * * 1-5: Write the brief."')
    expect(readFileSync(h.jobsFile, 'utf8')).toBe(before)
    expect(existsSync(`${h.jobsFile}.v1-backup`)).toBe(false)
  })

  it('names a schedule left on a task without a job, as the host\'s first pass of the space would remove it', async () => {
    const stale = { delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } } }
    const h = homeWith({ jobs: { version: 1, jobs: { j1: job('j1') }, runs: {}, keys: {} }, tasks: [{ id: 't1' }, { id: 'left', properties: stale }, { id: 'closed', status: 'resolved', properties: stale }] })
    await h.run()
    const text = h.printed.join('')
    expect(text).toContain('## Task left (left) — a schedule without a job')
    expect(text).not.toContain('Task closed')
  })

  it('a brain file still at schema 23: a schedule in the old shape is read as the host will find it after the brain moved, and the output says so', async () => {
    // schema 23 held one cron and a session; schema 24 holds a list of crons
    const old = (cron: string) => ({ delegation: { agent: 'atlas', schedule: { cron, time_zone: 'UTC', session: 'new' } } })
    const h = homeWith({ schema: 23, jobs: { version: 1, jobs: { j1: job('j1') }, runs: {}, keys: {} }, tasks: [{ id: 't1', properties: old('0 8 * * 1-5') }, { id: 'left', properties: old('0 7 * * *') }] })
    await h.run()
    const text = h.printed.join('')
    expect(text).toContain('Main: its brain is at schema 23: the host moves it at its first start on the new version; planned here as it will be then.\n\n# Schedules onto tasks — dry run\n')
    // the leftover is found, though it reads as no schedule in the new shape
    expect(text).toContain('## Task left (left) — a schedule without a job\n\n- A schedule without a job was left on this task (0 7 * * * (UTC)); removed.')
    // and the task's current schedule is the one its job gives it
    expect(text).toContain('- The task has that schedule already: it is not written again.')
    // a brain at schema 25 gets no such line
    const now = homeWith({ jobs: { version: 1, jobs: { j1: job('j1') }, runs: {}, keys: {} }, tasks: [{ id: 't1' }] })
    await now.run()
    expect(now.printed.join('')).not.toContain('its brain is at schema')
  })

  it('looks through the main space of a home that was on version 1 also when it holds no job; a home that never was has nothing to move', async () => {
    const stale = { delegation: { agent: 'atlas', schedule: { crons: ['0 7 * * *'], time_zone: 'UTC' } } }
    const was = homeWith({ jobs: { version: 1, jobs: {}, runs: {}, keys: {} }, tasks: [{ id: 'left', properties: stale }] })
    await was.run()
    expect(was.printed.join('')).toContain('## Task left (left) — a schedule without a job\n\n- A schedule without a job was left on this task (0 7 * * * (UTC)); removed.')
    // looked through already: nothing more to say
    const looked = homeWith({ jobs: { version: 2, timeZone: null, jobs: {}, runs: {}, keys: {}, fromV1: true, leftoversChecked: [''] }, tasks: [{ id: 'left', properties: stale }] })
    await looked.run()
    expect(looked.printed).toEqual(['jobs.json holds no version 1 jobs: nothing to move\n'])
    const never = homeWith({ jobs: { version: 2, timeZone: null, jobs: {}, runs: {}, keys: {} }, tasks: [{ id: 'left', properties: stale }] })
    await never.run()
    expect(never.printed).toEqual(['jobs.json holds no version 1 jobs: nothing to move\n'])
  })

  it('a job of a space this home no longer has stays as it is, and is counted', async () => {
    const h = homeWith({ jobs: { version: 1, jobs: { j9: job('j9', { spaceId: 'space-gone' }) }, runs: {}, keys: {} } })
    expect(await h.run()).toBe(true)
    expect(h.printed).toEqual([`Dry run on ${h.dir} as owner: nothing is written.\n\n`, '1 job(s) belong to a space this home no longer has: they stay as they are.\n'])
  })

  it('does not plan a space beside the main one: whether it is shared only its brain server says; one whose brain this home does not have is skipped', async () => {
    const h = homeWith({
      jobs: { version: 1, jobs: { j2: job('j2', { spaceId: 'space-2' }) }, runs: {}, keys: {} },
      spaces: [{ token: 'team-token', name: 'Team' }, { token: 'lost-token' }],
    })
    await h.run()
    const text = h.printed.join('')
    expect(text).toContain('# Team\n\nWhether this space is shared only its brain server says, and the dry run does not ask it: its 1 job(s) are not planned here.')
    expect(text).toContain('# Space\n\nIts brain is not in this home\'s control.db: skipped.')
    expect(text).not.toContain('belong to a space this home no longer has')
  })
})
