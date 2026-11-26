import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobStore } from '../src/job-store.js'
import { newRecord, type JobRun } from '../src/domain/job.js'

const run = (jobId: string, id: string, status: JobRun['status'] = 'finished'): JobRun => ({
  id, jobId, trigger: 'schedule', number: 1, dueAt: '2026-11-20T08:00:00.000Z', createdAt: '2026-11-20T08:00:00.000Z', status, attempts: 1,
  nextAttemptAt: null, sessionId: 's1', startedAt: '2026-11-20T08:00:01.000Z', finishedAt: null, outcome: null, note: null,
})
const v1Job = (id: string, patch: Record<string, unknown> = {}) => ({
  id, name: 'Daily brief', kind: 'routine', spaceId: null, createdBy: null, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', taskId: 't1',
  prompt: 'Write the brief.', target: { type: 'worker', projectId: 'bp-ops' }, triggers: [{ type: 'schedule', cron: '0 8 * * *', timeZone: 'UTC' }],
  toolProfile: null, reply: {}, end: null, notify: 'needs-me', paused: false, pausedReason: null, endedAt: null, nextRunAt: '2026-11-26T08:00:00.000Z', runCount: 1, failures: 0, ...patch,
})
const v1File = () => {
  const file = join(mkdtempSync(join(tmpdir(), 'cockpit-job-store-')), 'jobs.json')
  const content = JSON.stringify({ version: 1, timeZone: 'Asia/Makassar', jobs: { j1: v1Job('j1'), j2: v1Job('j2', { taskId: 't2' }) }, runs: { j1: [run('j1', 'r1')], gone: [run('gone', 'r9')] }, keys: { j1: { 'mail:1': '2026-11-20T08:00:00.000Z' } } })
  writeFileSync(file, content)
  return { file, content }
}
const read = (file: string) => JSON.parse(readFileSync(file, 'utf8'))

describe('jobs.json', () => {
  it('starts empty at version 2 and keeps a record, its runs and the time zone across a restart', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cockpit-job-store-')), 'jobs.json')
    const store = new JobStore(file)
    expect(store.list()).toEqual([])
    expect(store.pendingV1()).toBeNull()
    const record = newRecord({ id: 't1', spaceId: null }, '2026-11-25T00:00:00.000Z', 's1')
    expect(record).toMatchObject({ id: 't1', taskId: 't1', createdBy: 's1', triggers: [], cursor: null, firedWake: null, lastRunAt: null, runCount: 0, failures: 0, notify: 'needs-me', end: null })
    store.put(record)
    store.addRun(run('t1', 'r1'))
    store.setTimeZone('Europe/Berlin')
    expect(read(file).version).toBe(2)
    const again = new JobStore(file)
    expect(again.get('t1')).toEqual(record)
    expect(again.runs('t1')).toHaveLength(1)
    expect(again.timeZone()).toBe('Europe/Berlin')
  })

  it('reads a version 1 file without losing it: its jobs wait under v1, none of them is a record, the time zone is taken over', () => {
    const { file, content } = v1File()
    const store = new JobStore(file)
    expect(store.list()).toEqual([])
    expect(store.timeZone()).toBe('Asia/Makassar')
    expect(Object.keys(store.pendingV1()!.jobs)).toEqual(['j1', 'j2'])
    expect(store.pendingV1()!.runs.j1).toHaveLength(1)
    // reading alone rewrites nothing
    expect(readFileSync(file, 'utf8')).toBe(content)
    expect(existsSync(`${file}.v1-backup`)).toBe(false)
  })

  it('copies the version 1 file next to it before the first rewrite, and carries the version 1 jobs through every rewrite and restart', () => {
    const { file, content } = v1File()
    const store = new JobStore(file)
    store.setTimeZone('Europe/Berlin')
    expect(readFileSync(`${file}.v1-backup`, 'utf8')).toBe(content)
    expect(read(file)).toMatchObject({ version: 2, timeZone: 'Europe/Berlin', jobs: {}, v1: { jobs: { j1: { name: 'Daily brief' }, j2: {} }, keys: { j1: { 'mail:1': '2026-11-20T08:00:00.000Z' } } } })
    const again = new JobStore(file)
    expect(Object.keys(again.pendingV1()!.jobs)).toEqual(['j1', 'j2'])
    again.put(newRecord({ id: 't9', spaceId: null }, '2026-11-25T00:00:00.000Z'))
    expect(Object.keys(new JobStore(file).pendingV1()!.jobs)).toEqual(['j1', 'j2'])
    // the backup is the file as it was, not a later state
    expect(readFileSync(`${file}.v1-backup`, 'utf8')).toBe(content)
  })

  it('says which tasks still have version 1 jobs to move: one whose jobs moved, and one that never had any, has none', () => {
    const { file } = v1File()
    const store = new JobStore(file)
    expect([store.hasV1Jobs('t1'), store.hasV1Jobs('t2'), store.hasV1Jobs('t9')]).toEqual([true, true, false])
    store.migrateV1({ jobIds: ['j1'], record: null })
    expect([store.hasV1Jobs('t1'), store.hasV1Jobs('t2')]).toEqual([false, true])
    expect(new JobStore(join(mkdtempSync(join(tmpdir(), 'cockpit-job-store-')), 'jobs.json')).hasV1Jobs('t1')).toBe(false)
  })

  it('writes one task\'s part of the migration in one go: its jobs leave v1, its record, runs and keys are in, history stays under the old id', () => {
    const { file } = v1File()
    const store = new JobStore(file)
    const record = { ...newRecord({ id: 't1', spaceId: null }, '2026-11-25T00:00:00.000Z'), runCount: 1 }
    store.migrateV1({ jobIds: ['j1'], record, runs: [run('t1', 'r1', 'started')], keys: { 'mail:1': '2026-11-20T08:00:00.000Z' }, history: { old: [run('old', 'r0')] } })
    expect(store.get('t1')).toEqual(record)
    expect(store.runs('t1').map((r) => r.id)).toEqual(['r1'])
    expect(store.runs('old').map((r) => r.id)).toEqual(['r0'])
    expect(store.seenKey('t1', 'mail:1', 0)).toBe(true)
    expect(Object.keys(store.pendingV1()!.jobs)).toEqual(['j2'])
    expect(store.pendingV1()!.runs.j1).toBeUndefined()
    // a restart finds the same state
    const again = new JobStore(file)
    expect(Object.keys(again.pendingV1()!.jobs)).toEqual(['j2'])
    expect(again.get('t1')).toEqual(record)

    // the last job settled: v1 is gone, and runs of a job that was gone already stay as history
    again.migrateV1({ jobIds: ['j2'], record: null })
    expect(again.pendingV1()).toBeNull()
    expect(again.runs('gone').map((r) => r.id)).toEqual(['r9'])
    expect(read(file).v1).toBeUndefined()
    expect(new JobStore(file).pendingV1()).toBeNull()
  })

  it('keeps which job became which record until the channel bridge has confirmed the new id, across restarts', () => {
    const { file } = v1File()
    const store = new JobStore(file)
    expect(store.pendingRenames()).toEqual({})
    store.migrateV1({ jobIds: ['j1', 'j2'], record: newRecord({ id: 't1', spaceId: null }, '2026-11-25T00:00:00.000Z'), renames: { j1: 't1', j2: 't1' } })
    // the version 1 jobs are gone; the mapping outlives them
    expect(store.pendingV1()).toBeNull()
    expect(new JobStore(file).pendingRenames()).toEqual({ j1: 't1', j2: 't1' })
    store.renameConfirmed('j1')
    store.renameConfirmed('j1')
    expect(new JobStore(file).pendingRenames()).toEqual({ j2: 't1' })
    store.renameConfirmed('j2')
    expect(read(file)).not.toHaveProperty('renames')
    // a record written later does not bring one back
    store.put(newRecord({ id: 't2', spaceId: null }, '2026-11-25T00:00:00.000Z'))
    expect(new JobStore(file).pendingRenames()).toEqual({})
  })

  it('remembers per space that it was looked through for schedules left without a job, across restarts', () => {
    const { file } = v1File()
    const store = new JobStore(file)
    expect([store.leftoversChecked(null), store.leftoversChecked('space-2')]).toEqual([false, false])
    store.markLeftoversChecked(null)
    store.markLeftoversChecked(null)
    expect([new JobStore(file).leftoversChecked(null), new JobStore(file).leftoversChecked('space-2')]).toEqual([true, false])
    store.markLeftoversChecked('space-2')
    expect(new JobStore(file).leftoversChecked('space-2')).toBe(true)
  })

  it('a version 1 file without jobs has nothing to wait for; an unreadable or unknown file starts empty', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-job-store-'))
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ version: 1, timeZone: 'UTC', jobs: {}, runs: {}, keys: {} }))
    expect(new JobStore(join(dir, 'empty.json')).pendingV1()).toBeNull()
    writeFileSync(join(dir, 'bad.json'), 'not json')
    expect(new JobStore(join(dir, 'bad.json')).list()).toEqual([])
    writeFileSync(join(dir, 'later.json'), JSON.stringify({ version: 9, jobs: { x: {} } }))
    expect(new JobStore(join(dir, 'later.json')).list()).toEqual([])
  })

  it('without a file it keeps everything in memory and writes nothing', () => {
    const store = new JobStore(null)
    store.put(newRecord({ id: 't1', spaceId: null }, '2026-11-25T00:00:00.000Z'))
    store.setTimeZone('UTC')
    expect(store.list()).toHaveLength(1)
    expect(store.pendingV1()).toBeNull()
  })
})
