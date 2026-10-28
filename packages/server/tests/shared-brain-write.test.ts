import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { initControlDatabase, provisionUser, type ProvisionResult } from '@engramprotocol/core'
import { validNote, validTask } from '../../core/tests/fixtures'
import { request, waitForReady, flat } from './http-helpers'

// v0.21 write seam (write.ts): every write route goes through applyWrite. A
// shared brain — its genesis names a team brain — refuses writes with 503
// SHARED_BRAIN_READ_ONLY while this server has no relay connection; reads
// still work. A private brain next to it writes as before.

const TEAM_BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

describe('writes to a shared brain', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let shared: ProvisionResult
  let own: ProvisionResult
  const port = 31580 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`
  const as = (p: ProvisionResult) => ({ Authorization: `Bearer ${p.tokenPlaintext}` })
  const post = (p: ProvisionResult, path: string, body: unknown) => request('POST', `${baseUrl}${path}`, as(p), JSON.stringify(body))
  const put = (p: ProvisionResult, path: string, body: unknown) => request('PUT', `${baseUrl}${path}`, as(p), JSON.stringify(body))
  const get = (p: ProvisionResult, path: string) => request('GET', `${baseUrl}${path}`, as(p))
  const opLogSize = (): number => {
    const db = new Database(join(tmpDir, shared.brainFile), { readonly: true })
    try { return (db.prepare('SELECT COUNT(*) AS n FROM op_log').get() as { n: number }).n } finally { db.close() }
  }

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-shared-write-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    own = provisionUser({ email: 'own@example.com', agentId: 'default', userId: 'default', control, dataDir: tmpDir })
    shared = provisionUser({ email: 'shared@example.com', agentId: 'default', userId: 'default', control, dataDir: tmpDir })
    control.close()
    // What makes a brain shared: its genesis carries team fields. Only the
    // payload is rewritten — the seam reads the team brain, not the chain.
    const db = new Database(join(tmpDir, shared.brainFile))
    const genesis = JSON.parse((db.prepare('SELECT payload FROM op_log WHERE seq = 1').get() as { payload: string }).payload)
    genesis.team = { brain: TEAM_BRAIN, device: 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4', base_seq: 0, head_hash: '0'.repeat(64) }
    db.prepare('UPDATE op_log SET payload = ? WHERE seq = 1').run(JSON.stringify(genesis))
    db.close()
    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(port)
  }, 10000)

  afterAll(async () => {
    // Wait for the server to exit before removing its brains: Windows keeps an open file locked (EBUSY).
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses every write route with 503 SHARED_BRAIN_READ_ONLY and logs nothing', async () => {
    const note = flat(validNote({ title: 'shared write' }))
    const id = (await get(shared, '/list?limit=1')).body.engrams[0].id
    const before = opLogSize()
    const writes = [
      post(shared, `/engram/${note.type}`, note.body),
      post(shared, `/task/${id}/track`, { text: 'x' }),
      post(shared, '/learning', { content: 'x', scope: 'global', source: 'self', happened: 'x' }),
      post(shared, '/update', { id, patch: { title: 'x' } }),
      post(shared, `/engram/${id}/confirm-review`, { text: 'x' }),
      post(shared, '/object/tag', { name: 'shared-tag' }),
      put(shared, '/object/tag/shared-tag', { description: 'x' }),
      post(shared, '/relate', { source_id: id, target_id: id, relation: 'relates_to' }),
    ]
    for (const r of await Promise.all(writes)) {
      expect(r.status).toBe(503)
      expect(r.body.code).toBe('SHARED_BRAIN_READ_ONLY')
      expect(r.body.error).toMatch(/^This shared brain is read-only right now: .+\. Reads still work/)
    }
    expect(opLogSize()).toBe(before)
  })

  it('still serves reads', async () => {
    expect((await get(shared, '/list')).status).toBe(200)
    expect((await post(shared, '/recall', { query: 'anything' })).status).toBe(200)
  })

  it('a private brain on the same server writes as before', async () => {
    const task = flat(validTask({ title: 'private write' }))
    const r = await post(own, `/engram/${task.type}`, task.body)
    expect(r.status).toBe(201)
  })
})
