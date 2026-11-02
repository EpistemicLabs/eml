import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ready } from '@engramprotocol/protocol'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initControlDatabase, issueToken } from '@engramprotocol/core'
import { validNote } from '../../core/tests/fixtures'
import { writeTeamFile } from '../src/sync/team-file'
import { FakeRelay } from './fake-relay'
import { request, waitForReady, flat } from './http-helpers'
import { BRAIN, Team } from './team'

// v0.21 end to end: the spawned server syncs a shared brain — a brain file
// whose team file names its relay — and an HTTP write to it is a confirmed
// write through the relay.

describe('a shared brain through the server', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let relay: FakeRelay
  let token: string
  const port = 31680 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`
  const post = (path: string, body: unknown) => request('POST', `${baseUrl}${path}`, { Authorization: `Bearer ${token}` }, JSON.stringify(body))
  const get = (path: string) => request('GET', `${baseUrl}${path}`, { Authorization: `Bearer ${token}` })

  beforeAll(async () => {
    await ready()
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-shared-sync-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    // the brain file as a joining device starts it: the schema, no rows, no log
    const brainFile = `brains/${BRAIN}.db`
    const eml = new EML({ dbPath: join(tmpDir, brainFile), namespace: 'test', brainId: BRAIN })
    ;(eml as any).db.exec('DELETE FROM op_snapshots; DELETE FROM op_log')
    eml.close()
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'juno@example.com')`).run()
    control.prepare('INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)').run(BRAIN, 'default', 'u1', brainFile, CURRENT_BRAIN_SCHEMA_VERSION)
    token = issueToken(control, { userId: 'u1', brainId: BRAIN, name: 'juno' }).plaintext
    control.close()

    const team = new Team()
    relay = await FakeRelay.start(BRAIN, team.genesis())
    relay.putKey(team.owner.device.sign.publicKey, team.wrapped(0))
    writeTeamFile(tmpDir, { v: 1, brain: BRAIN, relay: relay.origin, device: team.owner.device })

    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(port)
  }, 10000)

  afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    await relay?.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('writes through the relay: 201 with the engram, in the relay\'s log and readable', async () => {
    const note = flat(validNote({ title: 't-through-the-relay' }))
    let r = await post(`/engram/${note.type}`, note.body)
    for (let i = 0; i < 50 && r.status === 503; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))  // until the sync is live
      r = await post(`/engram/${note.type}`, note.body)
    }
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ title: 't-through-the-relay', ingested_by: 'juno' })
    expect(relay.log).toHaveLength(2)
    const list = await get('/list?search=through')
    expect(list.body.engrams.map((e: { title: string }) => e.title)).toContain('t-through-the-relay')
  })

  it('is read-only while the relay is away', async () => {
    await relay.stop()
    await new Promise(resolve => setTimeout(resolve, 200))  // the server sees the connection drop
    const note = flat(validNote({ title: 't-while-away' }))
    const r = await post(`/engram/${note.type}`, note.body)
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('SHARED_BRAIN_READ_ONLY')
  })
})
