import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EML } from '@engramprotocol/core'
import { ReadError, ReadPool, ReadTimeoutError, defaultWorkerFile, readFailure } from '../src/read-pool'
import { readJob, type ReadJob } from '../src/read-worker'
import type { ReadAnswer } from '../src/reads'
import { validTask, writes } from '../../core/tests/fixtures'

// The read pool (read-pool.ts): its queue and its failures against small stand-in workers, and one read through the
// built worker (dist/read-worker.js — the server tests run against the build) on a brain file.

/** The worker of the build; the server's E2E tests need the build too. */
const BUILT_WORKER = join(__dirname, '..', 'dist', 'read-worker.js')

/** A stand-in worker: `args.ms` to wait, `args.exit` to die, `args.hang` to never answer; answers with its job's kind. */
const STAND_IN = `
const { parentPort } = require('worker_threads')
parentPort.on('message', (job) => {
  const args = job.args || {}
  if (args.exit) process.exit(3)
  if (args.hang) return
  if (args.fail) return parentPort.postMessage({ ok: false, error: args.fail, ...(args.code ? { code: args.code } : {}) })
  setTimeout(() => parentPort.postMessage({ ok: true, answer: { status: 200, body: JSON.stringify({ kind: job.kind, by: 'worker' }) } }), args.ms || 0)
})
`

let dir: string
let standIn: string
let pool: ReadPool | null = null
const logged: string[] = []
const job = (kind: string, args: Record<string, unknown> = {}) => ({ file: 'none', name: 'test', kind, args }) as unknown as ReadJob
const inline = (j: ReadJob): ReadAnswer => ({ status: 200, body: JSON.stringify({ kind: j.kind, by: 'inline' }) })
const by = (a: ReadAnswer) => (JSON.parse(a.body) as { by: string }).by
const make = (opts: Partial<ConstructorParameters<typeof ReadPool>[0]> = {}) => {
  pool = new ReadPool({ inline, workerFile: standIn, log: (line) => logged.push(line), ...opts })
  return pool
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'eml-read-pool-'))
  standIn = join(dir, 'stand-in.cjs')
  writeFileSync(standIn, STAND_IN)
})
afterEach(async () => { await pool?.close(); pool = null; logged.length = 0 })
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

describe('ReadPool', () => {
  it('runs a job in a worker', async () => {
    expect(by(await make().run(job('a')))).toBe('worker')
  })

  it('runs every job on the calling thread without a worker file or with no workers', async () => {
    expect(make({ workerFile: null }).threaded).toBe(false)
    expect(by(await pool!.run(job('a')))).toBe('inline')
    await pool!.close()
    expect(by(await make({ size: 0 }).run(job('a')))).toBe('inline')
  })

  it('answers the jobs in the order they came when one worker takes them', async () => {
    const p = make({ size: 1 })
    const done: string[] = []
    await Promise.all(['a', 'b', 'c'].map((kind, i) => p.run(job(kind, { ms: 30 - i * 10 })).then(() => done.push(kind))))
    expect(done).toEqual(['a', 'b', 'c'])
  })

  it('keeps a worker free of slow jobs, so a quick one does not wait for them', async () => {
    const p = make({ size: 2 })
    const done: string[] = []
    const all = [
      p.run(job('slow-1', { ms: 150 }), { slow: true }).then(() => done.push('slow-1')),
      p.run(job('slow-2', { ms: 150 }), { slow: true }).then(() => done.push('slow-2')),
      p.run(job('quick', { ms: 0 })).then(() => done.push('quick')),
    ]
    await Promise.all(all)
    expect(done).toEqual(['quick', 'slow-1', 'slow-2'])
  })

  it('hands on what a read threw: its message, and the code of a rejected command', async () => {
    const p = make()
    await expect(p.run(job('a', { fail: 'Invalid scope "x"' }))).rejects.toMatchObject({ name: 'ReadError', message: 'Invalid scope "x"', code: undefined })
    await expect(p.run(job('a', { fail: 'no such task', code: 'NOT_FOUND' }))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // the worker is still there for the next job
    expect(by(await p.run(job('b')))).toBe('worker')
  })

  it('wraps what an inline read throws the same way', async () => {
    const p = make({ workerFile: null, inline: () => { throw new Error('Invalid scope "x"') } })
    await expect(p.run(job('a'))).rejects.toBeInstanceOf(ReadError)
  })

  it('runs the job of a worker that died on the calling thread, and starts another worker for the next', async () => {
    const p = make({ size: 1 })
    expect(by(await p.run(job('a')))).toBe('worker')
    expect(by(await p.run(job('b', { exit: true })))).toBe('inline')
    expect(logged.join('\n')).toContain('its read runs on the request thread')
    expect(by(await p.run(job('c')))).toBe('worker')
  })

  it('stops starting workers after three that never answered, and says so once more', async () => {
    const p = make({ size: 1, workerFile: join(dir, 'missing.cjs') })
    for (const kind of ['a', 'b', 'c', 'd']) expect(by(await p.run(job(kind)))).toBe('inline')
    expect(p.threaded).toBe(false)
    expect(logged).toHaveLength(3)
    expect(logged[2]).toContain('reads run on the request thread from now on')
  })

  it('stops a job that runs too long, refuses it, and goes on with a new worker', async () => {
    const p = make({ size: 1, timeoutMs: 50 })
    await expect(p.run(job('stuck', { hang: true }))).rejects.toBeInstanceOf(ReadTimeoutError)
    expect(logged.join('\n')).toContain('a stuck read ran longer than')
    expect(by(await p.run(job('next'), { timeoutMs: 5000 }))).toBe('worker')
  })

  it('gives a job its own time limit', async () => {
    const p = make({ size: 1, timeoutMs: 20 })
    expect(by(await p.run(job('long', { ms: 80 }), { timeoutMs: 1000 }))).toBe('worker')
  })

  it('refuses the jobs that wait or run when it is closed', async () => {
    const p = make({ size: 1 })
    const refused = [p.run(job('a', { hang: true })), p.run(job('b'))].map((run) => expect(run).rejects.toThrow('shutting down'))
    await p.close()
    await Promise.all(refused)
  })
})

describe('defaultWorkerFile', () => {
  it('finds the worker of a tsc build or of a bundle next to the server, and none where neither is', () => {
    const at = (name: string) => { const d = mkdtempSync(join(dir, 'build-')); if (name) writeFileSync(join(d, name), ''); return d }
    const tsc = at('read-worker.js')
    const bundle = at('read-worker.cjs')
    expect(defaultWorkerFile(tsc)).toBe(join(tsc, 'read-worker.js'))
    expect(defaultWorkerFile(bundle)).toBe(join(bundle, 'read-worker.cjs'))
    expect(defaultWorkerFile(at(''))).toBeNull()
  })
})

describe('readFailure', () => {
  it('answers a read that ran too long with a 503 the caller may try again', () => {
    expect(readFailure(new ReadTimeoutError('hygiene', 120_000))).toEqual({ status: 503, body: { error: 'The hygiene read took longer than 120 s and was stopped', code: 'READ_TIMEOUT' } })
  })

  it('answers a read core rejected as the command error it was', () => {
    expect(readFailure(new ReadError('no such task', 'NOT_FOUND'))).toEqual({ status: 404, body: { error: 'no such task' } })
    expect(readFailure(new ReadError('the topic exists', 'TOPIC_EXISTS'))).toEqual({ status: 409, body: { error: 'the topic exists' } })
    expect(readFailure(new ReadError('Invalid engram: nope', 'INVALID'))).toEqual({ status: 400, body: { error: 'Invalid engram: nope' } })
  })

  it('leaves everything else to the route: a read error without a code, any other error', () => {
    expect(readFailure(new ReadError('Invalid scope "x"'))).toBeNull()
    expect(readFailure(new Error('boom'))).toBeNull()
  })
})

describe('a read through the built worker', () => {
  it.skipIf(!existsSync(BUILT_WORKER))('reads a brain file beside its writing connection, and sees a write as soon as it is committed', async () => {
    const file = join(dir, 'brain.db')
    const eml = new EML({ dbPath: file, namespace: 'test' })
    try {
      const first = writes(eml).store(validTask({ title: 'first-task' }))
      const p = make({ workerFile: BUILT_WORKER, inline: readJob, size: 1 })
      const list = async () => JSON.parse((await p.run({ file, name: 'test', kind: 'list', args: { q: { type: 'task' }, reviewDue: undefined } })).body) as { count: number, engrams: Array<{ id: string }> }
      expect((await list()).engrams.map((e) => e.id)).toEqual([first.id])
      const second = writes(eml).store(validTask({ title: 'second-task' }))
      expect((await list()).engrams.map((e) => e.id).sort()).toEqual([first.id, second.id].sort())
      // the same read on the calling thread answers the same
      expect(JSON.parse(readJob({ file, name: 'test', kind: 'list', args: { q: { type: 'task' }, reviewDue: undefined } }).body).count).toBe(2)
    } finally {
      eml.close()
    }
  })
})
