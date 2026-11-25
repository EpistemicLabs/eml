import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalFold, newestRunDir, projectSlug, watchWorkflowJournal, WorkflowJournal, workflowsDir } from '../src/infrastructure/providers/claude/workflow-journal.js'

const key = (n: number) => `v2:${String(n).padStart(64, '0')}`
const line = (entry: object) => `${JSON.stringify(entry)}\n`
const started = (n: number, phase = 'Review') => line({ type: 'started', key: key(n), agentId: `a${n}`, label: `agent ${n}`, phase })
const result = (n: number) => line({ type: 'result', key: key(n), agentId: `a${n}`, result: { ok: true } })
const failed = (n: number) => line({ type: 'failed', key: key(n), agentId: '' })

describe('JournalFold', () => {
  it('counts running and finished agents, and the phase of the latest start', () => {
    const fold = new JournalFold()
    for (const text of [line({ type: 'launched' }), started(1), started(2), result(1), started(3, 'Verify'), failed(2)]) fold.add(text)
    expect(fold.progress()).toEqual({ running: 1, done: 2, phase: 'Verify' })
  })

  it('takes a retried agent as running again, and skips what is no entry', () => {
    const fold = new JournalFold()
    for (const text of [started(1), failed(1), started(1), 'not json', '{"type":"started"}', 'null']) fold.add(text)
    expect(fold.progress()).toEqual({ running: 1, done: 0, phase: 'Review' })
  })
})

describe('WorkflowJournal', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-journal-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('follows the journal as it grows and says only what changed', async () => {
    const journal = new WorkflowJournal(() => dir)
    // Not written yet.
    expect(await journal.poll()).toBeNull()
    writeFileSync(join(dir, 'journal.jsonl'), line({ type: 'launched' }))
    expect(await journal.poll()).toBeNull()
    appendFileSync(join(dir, 'journal.jsonl'), started(1) + started(2))
    expect(await journal.poll()).toEqual({ running: 2, done: 0, phase: 'Review' })
    expect(await journal.poll()).toBeNull()
    appendFileSync(join(dir, 'journal.jsonl'), result(1))
    expect(await journal.poll()).toEqual({ running: 1, done: 1, phase: 'Review' })
  })

  it('keeps a last line without its newline until it is complete', async () => {
    const journal = new WorkflowJournal(() => dir)
    const whole = started(1)
    writeFileSync(join(dir, 'journal.jsonl'), whole.slice(0, 20))
    expect(await journal.poll()).toBeNull()
    appendFileSync(join(dir, 'journal.jsonl'), whole.slice(20))
    expect(await journal.poll()).toEqual({ running: 1, done: 0, phase: 'Review' })
  })

  it('waits for its folder until it can be found', async () => {
    let found: string | null = null
    const journal = new WorkflowJournal(async () => found)
    expect(await journal.poll()).toBeNull()
    writeFileSync(join(dir, 'journal.jsonl'), started(1))
    found = dir
    expect(await journal.poll()).toEqual({ running: 1, done: 0, phase: 'Review' })
  })

  it('reads a journal that shrank from the start again', async () => {
    const journal = new WorkflowJournal(() => dir)
    writeFileSync(join(dir, 'journal.jsonl'), started(1) + started(2) + result(1))
    expect(await journal.poll()).toEqual({ running: 1, done: 1, phase: 'Review' })
    writeFileSync(join(dir, 'journal.jsonl'), started(3, 'Verify'))
    expect(await journal.poll()).toEqual({ running: 1, done: 0, phase: 'Verify' })
  })

  // Windows opens a folder like a file, so there is no portable way to fail the open there.
  it.skipIf(process.platform === 'win32')('passes on a read that fails for another reason than a missing file', async () => {
    mkdirSync(join(dir, 'journal.jsonl'))
    await expect(new WorkflowJournal(() => dir).poll()).rejects.toMatchObject({ code: expect.stringMatching(/^E[A-Z]+$/) })
  })
})

describe('finding a run\'s folder', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-runs-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('builds the session\'s workflows folder the way Claude Code names project folders', () => {
    expect(projectSlug('/home/me/.eml-cockpit/work_1')).toBe('-home-me--eml-cockpit-work-1')
    expect(workflowsDir('/cfg', '/home/me/repo', 'c1')).toBe(join('/cfg', 'projects', '-home-me-repo', 'c1', 'subagents', 'workflows'))
  })

  it('takes the newest run folder made since the run started', async () => {
    expect(await newestRunDir(join(dir, 'missing'), 0)).toBeNull()
    mkdirSync(join(dir, 'wf_old'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    // A file's time can lag the clock by a moment.
    const since = Date.now() - 20
    expect(await newestRunDir(dir, since)).toBeNull()
    mkdirSync(join(dir, 'wf_new'))
    writeFileSync(join(dir, 'a-file'), '')
    expect(await newestRunDir(dir, since)).toBe(join(dir, 'wf_new'))
  })
})

describe('watchWorkflowJournal', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wf-watch-')) })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reports progress until it is stopped', async () => {
    const seen: unknown[] = []
    writeFileSync(join(dir, 'journal.jsonl'), started(1))
    const watch = watchWorkflowJournal({ taskId: 'w1', locate: () => dir, onProgress: (progress) => seen.push(progress), intervalMs: 10 })
    await vi.waitFor(() => expect(seen).toEqual([{ running: 1, done: 0, phase: 'Review' }]))
    appendFileSync(join(dir, 'journal.jsonl'), result(1))
    await vi.waitFor(() => expect(seen).toHaveLength(2))
    watch.stop()
    appendFileSync(join(dir, 'journal.jsonl'), started(2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(seen).toEqual([{ running: 1, done: 0, phase: 'Review' }, { running: 0, done: 1, phase: 'Review' }])
  })

  it('says nothing while the journal is not written, and tells a failed read once', async () => {
    const lines: string[] = []
    const quiet = watchWorkflowJournal({ taskId: 'w1', locate: () => join(dir, 'missing'), onProgress: () => {}, intervalMs: 10, log: (text) => lines.push(text) })
    // A read that fails for another reason than a missing file; the same on every platform (Windows opens a folder).
    const denied = () => Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
    const broken = watchWorkflowJournal({ taskId: 'w2', locate: denied, onProgress: () => {}, intervalMs: 10, log: (text) => lines.push(text) })
    await vi.waitFor(() => expect(lines).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 60))
    quiet.stop()
    broken.stop()
    expect(lines).toEqual([expect.stringMatching(/^\[workflow\] cannot read the journal of w2: E[A-Z]+$/)])
  })
})
