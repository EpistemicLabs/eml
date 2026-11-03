import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newDeviceKeys, ready } from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, initControlDatabase, initDatabase, issueToken, provisionUser } from '@engramprotocol/core'
import { validNote } from '../../core/tests/fixtures'
import { teamFilePath, writeTeamFile } from '../src/sync/team-file'
import { FakeRelay, GRANT } from './fake-relay'
import { request, waitForReady, flat } from './http-helpers'
import { BRAIN, OTHER } from './team'

// v0.21 end to end: the spawned server founds a team brain in an empty brain
// (POST /team/create), syncs it with its relay, and an HTTP write to it is a
// confirmed write through the relay. A brain whose team file cannot be used is
// shared and read-only, with a fixed reason.

const BROKEN = '1c9e6679-7425-40de-944b-e07fc1f90a01'  // its team file is cut off in the middle of a seed
const RETRY = '2c9e6679-7425-40de-944b-e07fc1f90a02'   // created with a stale grant first

describe('a shared brain through the server', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let relay: FakeRelay
  let retryRelay: FakeRelay
  let stderr = ''
  let seed: string
  const tokens: Record<string, string> = {}
  const port = 31680 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`
  const post = (brain: string, path: string, body: unknown) => request('POST', `${baseUrl}${path}`, { Authorization: `Bearer ${tokens[brain]}` }, JSON.stringify(body))
  const get = (brain: string, path: string) => request('GET', `${baseUrl}${path}`, { Authorization: `Bearer ${tokens[brain]}` })

  beforeAll(async () => {
    await ready()
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-shared-sync-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'juno@example.com')`).run()
    // empty brains as the host provisions them for a creation: the schema, no rows, no log
    for (const id of [BRAIN, BROKEN, RETRY]) {
      const brainFile = `brains/${id}.db`
      initDatabase(join(tmpDir, brainFile), undefined, id, { log: false }).close()
      control.prepare('INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)').run(id, 'team', 'u1', brainFile, CURRENT_BRAIN_SCHEMA_VERSION)
      tokens[id] = issueToken(control, { userId: 'u1', brainId: id, name: 'juno' }).plaintext
    }
    // a private brain, provisioned as usual
    const own = provisionUser({ email: 'juno@example.com', agentId: 'pilot', userId: 'juno', control, dataDir: tmpDir })
    tokens[OTHER] = own.tokenPlaintext
    control.close()

    // BROKEN's team file: a good one, cut off inside the device's signing seed
    const device = newDeviceKeys()
    writeTeamFile(tmpDir, { v: 1, brain: BROKEN, relay: 'wss://relay.test', device })
    const text = readFileSync(teamFilePath(tmpDir, BROKEN), 'utf-8')
    seed = Buffer.from(device.sign.seed).toString('base64url')
    writeFileSync(teamFilePath(tmpDir, BROKEN), text.slice(0, text.indexOf(seed) + 20))

    relay = await FakeRelay.start(BRAIN)
    retryRelay = await FakeRelay.start(RETRY)
    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    await waitForReady(port)
  }, 10000)

  afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    await relay?.stop()
    await retryRelay?.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('refuses a creation with a relay that is no origin, a handle that is none, or without a grant', async () => {
    expect(await post(BRAIN, '/team/create', { relay: 'https://relay.test', grant: GRANT, handle: 'juno' })).toMatchObject({ status: 400, body: { code: 'INVALID_RELAY', error: 'The relay is a wss:// origin (scheme and host, no path).' } })
    expect(await post(BRAIN, '/team/create', { relay: 'ws://relay.test', grant: GRANT, handle: 'juno' })).toMatchObject({ status: 400, body: { code: 'INVALID_RELAY' } })
    expect(await post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'Juno!' })).toMatchObject({ status: 400, body: { code: 'INVALID_HANDLE', error: 'A handle is 1–63 characters of a–z, 0–9, _ and -.' } })
    expect(await post(BRAIN, '/team/create', { relay: relay.origin, handle: 'juno' })).toMatchObject({ status: 400, body: { error: 'grant required' } })
    expect(relay.creates).toEqual([])
  })

  it('refuses a creation into a brain that has a log already', async () => {
    const r = await post(OTHER, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })
    expect(r).toMatchObject({ status: 409, body: { code: 'TEAM_BRAIN_NOT_EMPTY', error: 'This brain already has a log; a team brain is created or joined only into a new, empty brain.' } })
  })

  it('an empty brain takes no write before its creation', async () => {
    const note = flat(validNote({ title: 't-before-creation' }))
    const r = await post(BRAIN, `/engram/${note.type}`, note.body)
    expect(r).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY' } })
    expect(r.body.error).toBe('This shared brain is read-only right now: it is not created yet. Reads still work; try the write again once it is back.')
  })

  it('founds the team brain once for two requests that arrive together: 201 for both with the same member, again when asked again, and its team file holds no pending creation', async () => {
    const [r, twin] = await Promise.all([
      post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' }),
      post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' }),
    ])
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ brain: BRAIN, handle: 'juno' })
    expect(r.body.member).toMatch(/^([0-9a-f]{5} ){7}[0-9a-f]{5}$/)
    expect(twin).toMatchObject({ status: 201, body: r.body })
    expect(relay.log).toHaveLength(1)
    const again = await post(BRAIN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })
    expect(again).toMatchObject({ status: 201, body: r.body })
    expect(relay.creates).toEqual([GRANT])
    for (let i = 0; i < 50 && relay.keyPuts.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 20))
    const file = JSON.parse(readFileSync(teamFilePath(tmpDir, BRAIN), 'utf-8'))
    expect(file.create).toBeUndefined()
    expect(file.key).toBeUndefined()
    expect(file.identity).toBeDefined()
  })

  it('writes through the relay: 201 with the engram, in the relay\'s log and readable, as the member', async () => {
    const note = flat(validNote({ title: 't-through-the-relay' }))
    const r = await post(BRAIN, `/engram/${note.type}`, note.body)
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ title: 't-through-the-relay', ingested_by: 'juno' })
    expect(relay.log).toHaveLength(2)
    const list = await get(BRAIN, '/list?search=through')
    expect(list.body.engrams.map((e: { title: string }) => e.title)).toContain('t-through-the-relay')
  })

  it('a creation the relay refuses leaves the brain new and empty: 403 GRANT_INVALID, then created with a good grant', async () => {
    const r = await post(RETRY, '/team/create', { relay: retryRelay.origin, grant: 'stale', handle: 'juno' })
    expect(r).toMatchObject({ status: 403, body: { code: 'GRANT_INVALID', error: 'The relay did not accept the creation grant: the grant is not good for this brain. Try again.' } })
    expect(existsSync(teamFilePath(tmpDir, RETRY))).toBe(false)
    const ok = await post(RETRY, '/team/create', { relay: retryRelay.origin, grant: GRANT, handle: 'juno' })
    expect(ok.status).toBe(201)
    expect(retryRelay.creates).toEqual(['stale', GRANT])
    expect(retryRelay.log).toHaveLength(1)
  })

  it('a brain whose team file cannot be used is read-only with a fixed reason, and nothing of the file is in the text or the log', async () => {
    const note = flat(validNote({ title: 't-broken' }))
    const r = await post(BROKEN, `/engram/${note.type}`, note.body)
    expect(r).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY' } })
    expect(r.body.error).toBe('This shared brain is read-only right now: it stopped: its team file cannot be used (it is not valid JSON). Reads still work; this needs the user — tell them.')
    const create = await post(BROKEN, '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })
    expect(create).toMatchObject({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY', error: r.body.error } })
    expect(stderr).toContain(`[sync] ${BROKEN}: its team file cannot be used (it is not valid JSON)`)
    for (let i = 0; i + 8 <= seed.length; i++) {
      expect(r.body.error).not.toContain(seed.slice(i, i + 8))
      expect(stderr).not.toContain(seed.slice(i, i + 8))
    }
    expect((await get(BROKEN, '/list')).status).toBe(200)
  })

  it('is read-only while the relay is away', async () => {
    await relay.stop()
    await new Promise(resolve => setTimeout(resolve, 200))  // the server sees the connection drop
    const note = flat(validNote({ title: 't-while-away' }))
    const r = await post(BRAIN, `/engram/${note.type}`, note.body)
    expect(r.status).toBe(503)
    expect(r.body.code).toBe('SHARED_BRAIN_READ_ONLY')
  })
})
