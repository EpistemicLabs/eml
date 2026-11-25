import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION, EML } from '@engramprotocol/core'
import { readJob, type ReadJob } from '../src/read-worker'
import type { ReadArgs, ReadKind } from '../src/reads'
import { validDecision, validNote, validTask, writes } from '../../core/tests/fixtures'

// Each read of reads.ts on a brain file, the way a job runs it (read-worker.ts readJob: a read-only connection of its
// own), beside the connection that writes.

let dir: string
let file: string
let eml: EML
let task: { id: string }

const read = <K extends ReadKind>(kind: K, args: ReadArgs<K>) => {
  const answer = readJob({ file, name: 'test', kind, args } as ReadJob)
  return { status: answer.status, body: JSON.parse(answer.body) }
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eml-reads-'))
  file = join(dir, 'brain.db')
  eml = new EML({ dbPath: file, namespace: 'test' })
  writes(eml).agents.store({ id: 'assistant', name: 'Assistant' })
  writes(eml).projects.create({ id: 'demo', name: 'Demo' })
  writes(eml).projects.create({ id: 'empty', name: 'Empty' })
  const parent = writes(eml).store(validTask({ scope: 'project.demo', title: 'parent-task', status: 'active' }))
  task = writes(eml).store(validTask({ scope: 'project.demo', title: 'child-task', parent_id: parent.id }))
  writes(eml).trackTask(task.id, { text: 'half way there' })
  const decision = writes(eml).store(validDecision({ scope: 'project.demo', title: 'use-the-read-pool', content: 'Reads that grow with the brain run in worker threads.' }))
  const note = writes(eml).store(validNote({ scope: 'project.demo', title: 'worker-note', content: 'The worker opens the brain read-only.' }))
  writes(eml).relate({ source_id: note.id, target_id: decision.id, relation: 'supports' })
  writes(eml).store(validNote({ scope: 'global', title: 'elsewhere', content: 'Not in the project.' }))
})
afterAll(() => { eml.close(); rmSync(dir, { recursive: true, force: true }) })

describe('the reads, on a brain file', () => {
  it('list: the engrams the query asks for', () => {
    const { status, body } = read('list', { q: { type: 'note' }, reviewDue: undefined })
    expect(status).toBe(200)
    expect(body.count).toBe(2)
    expect(body.engrams.map((e: { title: string }) => e.title).sort()).toEqual(['elsewhere', 'worker-note'])
  })

  it('list: a task with its parent, its origin and its newest note when asked', () => {
    const { body } = read('list', { q: { type: 'task', with_parent: 'true', with_origin: 'true', with_latest_note: 'true' }, reviewDue: undefined })
    const child = body.engrams.find((e: { id: string }) => e.id === task.id)
    expect(child.parent_id).toEqual(expect.any(String))
    expect(child.origin_task_id).toBeNull()
    expect(child.latest_note).toMatchObject({ text: 'half way there' })
    const plain = read('list', { q: { type: 'task' }, reviewDue: undefined }).body.engrams[0]
    expect(plain).not.toHaveProperty('parent_id')
  })

  it('recall: the compact markdown of what matches, not the engrams', () => {
    const { status, body } = read('recall', { query: 'worker read-only' })
    expect(status).toBe(200)
    expect(body.query).toBe('worker read-only')
    expect(body.engrams).toBeGreaterThan(0)
    expect(body.markdown).toContain('worker-note')
    expect(read('recall', { query: 'worker', limit: 1 }).body.engrams).toBe(1)
  })

  it('brain-state: a scope\'s dashboard as markdown', () => {
    const { status, body } = read('brain-state', { scope: 'project.demo' })
    expect(status).toBe(200)
    expect(body.scope).toBe('project.demo')
    expect(body.markdown).toContain('## Open tasks (2)')
    expect(body.markdown).toContain('child-task')
  })

  it('stats: the counts by type and scope', () => {
    const { status, body } = read('stats', undefined)
    expect(status).toBe(200)
    expect(body).toMatchObject({ total_engrams: 5, by_type: { task: 2, note: 2, decision: 1 }, by_scope: { 'project.demo': 4, global: 1 }, agents: 1, projects: 2 })
  })

  it('project-engrams: a project\'s engrams, and a 404 for a project that is not there', () => {
    const found = read('project-engrams', { id: 'demo', q: { type: 'note' }, reviewDue: undefined })
    expect(found.status).toBe(200)
    expect(found.body.engrams.map((e: { title: string }) => e.title)).toEqual(['worker-note'])
    expect(read('project-engrams', { id: 'empty', q: {}, reviewDue: undefined }).body).toEqual({ count: 0, engrams: [] })
    expect(read('project-engrams', { id: 'ghost', q: {}, reviewDue: undefined })).toEqual({ status: 404, body: { error: 'project "ghost" not found' } })
  })

  it('project-relations: the relations in a project, and a 404 for a project that is not there', () => {
    const found = read('project-relations', { id: 'demo' })
    expect(found.status).toBe(200)
    expect(found.body.relations.map((r: { relation: string }) => r.relation)).toEqual(expect.arrayContaining(['supports', 'part_of']))
    expect(found.body.count).toBe(found.body.relations.length)
    expect(read('project-relations', { id: 'ghost' })).toEqual({ status: 404, body: { error: 'project "ghost" not found' } })
  })

  it('hygiene: the report with the log head and the time it is from, and the state the next sweep starts from', () => {
    const head = (eml as unknown as { db: { prepare(sql: string): { get(): { seq: number } } } }).db.prepare('SELECT MAX(seq) AS seq FROM op_log').get().seq
    const { status, body } = read('hygiene', {})
    expect(status).toBe(200)
    expect(body.seq).toBe(head)
    expect(Number.isFinite(Date.parse(body.computed_at))).toBe(true)
    expect(body.report).toMatchObject({ schema: CURRENT_BRAIN_SCHEMA_VERSION, total: expect.any(Number) })
    expect(body.report.checks.at(-1).id).toBe('conflict-scan')
    expect(Object.keys(body.conflicts.revs).length).toBeGreaterThan(0)
    // from that state: the same report while nothing changed
    expect(read('hygiene', { previous: body.conflicts }).body.report.checks).toEqual(body.report.checks)
  })

  it('refuses a read it does not know', () => {
    expect(() => readJob({ file, name: 'test', kind: 'drop-everything', args: {} } as unknown as ReadJob)).toThrow('unknown read: drop-everything')
  })

  it('never writes: the connection it opens is read-only', () => {
    const before = (eml as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT COUNT(*) AS n FROM op_log').get().n
    read('stats', undefined)
    read('list', { q: { type: 'task', with_latest_note: 'true' }, reviewDue: undefined })
    read('hygiene', {})
    expect((eml as unknown as { db: { prepare(sql: string): { get(): { n: number } } } }).db.prepare('SELECT COUNT(*) AS n FROM op_log').get().n).toBe(before)
  })
})
