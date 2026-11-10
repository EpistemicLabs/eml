import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { ready } from '@engramprotocol/protocol'
import { CURRENT_BRAIN_SCHEMA_VERSION, initControlDatabase, initDatabase, issueToken, provisionUser, type ProvisionResult } from '@engramprotocol/core'
import { validNote, validTask } from '../../core/tests/fixtures'
import { FakeRelay, GRANT } from './fake-relay'
import { request, waitForReady, flat } from './http-helpers'
import { BRAIN } from './team'

// v0.21 (spec team-brain-move-project-spec, block 2): a project leaves a
// private brain for a team brain of the same server — the plan on the source
// brain's token, the run against the plan's hash, the import as a confirmed
// write through the relay, the source archived and backed up.

describe('moving a project into a team brain', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  let relay: FakeRelay
  let own: ProvisionResult
  let other: ProvisionResult
  /** a private brain holding a reference into the source: an agent brain's learning about the task */
  let agent: ProvisionResult
  let stderr = ''
  const tokens: Record<string, string> = {}
  const port = 31780 + Math.floor(Math.random() * 100)
  const baseUrl = `http://127.0.0.1:${port}`
  const as = (token: string) => ({ Authorization: `Bearer ${token}` })
  const post = (token: string, path: string, body: unknown) => request('POST', `${baseUrl}${path}`, as(token), JSON.stringify(body))
  const get = (token: string, path: string) => request('GET', `${baseUrl}${path}`, as(token))
  const ids: Record<string, string> = {}
  const opLog = (file: string, sql = 'SELECT COUNT(*) AS n FROM op_log'): number => {
    const db = new Database(join(tmpDir, file), { readonly: true })
    try { return (db.prepare(sql).get() as { n: number }).n } finally { db.close() }
  }

  beforeAll(async () => {
    await ready()
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-move-project-'))
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    const control = initControlDatabase(join(tmpDir, 'control.db'))
    control.prepare(`INSERT INTO users (id, email) VALUES ('u1', 'juno@example.com')`).run()
    // the empty brain the team brain is founded in
    initDatabase(join(tmpDir, `brains/${BRAIN}.db`), undefined, BRAIN, { log: false }).close()
    control.prepare('INSERT INTO brains (id, name, owner_id, brain_file, schema_version) VALUES (?, ?, ?, ?, ?)').run(BRAIN, 'team', 'u1', `brains/${BRAIN}.db`, CURRENT_BRAIN_SCHEMA_VERSION)
    tokens[BRAIN] = issueToken(control, { userId: 'u1', brainId: BRAIN, name: 'juno' }).plaintext
    // the private source, and another private brain
    own = provisionUser({ email: 'juno@example.com', agentId: 'pilot', userId: 'juno', control, dataDir: tmpDir })
    other = provisionUser({ email: 'other@example.com', agentId: 'pilot', userId: 'juno', control, dataDir: tmpDir })
    agent = provisionUser({ email: 'agent@example.com', agentId: 'pilot', userId: 'juno', control, dataDir: tmpDir })
    control.close()
    relay = await FakeRelay.start(BRAIN)
    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: { ...process.env, EML_PORT: String(port), EML_HOST: '127.0.0.1', EML_DATA_DIR: tmpDir, EML_MOVE_DEADLINE_MS: '2000' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    serverProc.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    await waitForReady(port)
    expect((await post(tokens[BRAIN], '/team/create', { relay: relay.origin, grant: GRANT, handle: 'juno' })).status).toBe(201)

    // the source: project top with sub-project child, a task with a journal in
    // top, a note in child linked to a note in project elsewhere (a crossing link)
    const t = own.tokenPlaintext
    for (const fields of [{ id: 'top', name: 'Top' }, { id: 'child', name: 'Child', parent_project: 'top' }, { id: 'elsewhere', name: 'Elsewhere' }]) {
      expect((await post(t, '/object/project', fields)).status).toBe(201)
    }
    const task = flat(validTask({ scope: 'project.top', title: 'hub', status: 'active' }))
    const created = (await post(t, `/engram/${task.type}`, task.body)).body
    ids.task = created.id
    ids.author = created.ingested_by
    expect((await post(t, `/task/${ids.task}/track`, { text: 'progress' })).status).toBe(200)
    const note = flat(validNote({ scope: 'project.child', title: 'in-child' }))
    ids.note = (await post(t, `/engram/${note.type}`, note.body)).body.id
    const outside = flat(validNote({ scope: 'project.elsewhere', title: 'outside' }))
    ids.outside = (await post(t, `/engram/${outside.type}`, outside.body)).body.id
    expect((await post(t, '/relate', { source_id: ids.note, target_id: ids.outside, relation: 'related_to', detection_method: 'manual' })).status).toBe(201)
    // the agent brain: a lesson that refines the task in the source (a cross-brain reference, spec §4)
    const lesson = flat(validNote({ scope: 'global', title: 'a-lesson' }))
    ids.lesson = (await post(agent.tokenPlaintext, `/engram/${lesson.type}`, lesson.body)).body.id
    expect((await post(agent.tokenPlaintext, '/relate', { source_id: ids.lesson, target_id: ids.task, relation: 'refines', detection_method: 'manual', target_brain: own.brainId })).status).toBe(201)
  }, 15000)

  afterAll(async () => {
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    await relay?.stop()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('plans: the tree, what moves, what is dropped, the hash; refusals for a target that is no team brain, unknown, or this brain', async () => {
    const r = await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      project: 'top', source: own.brainId, target: BRAIN,
      tree: [{ id: 'top', engrams: 1 }, { id: 'child', engrams: 1 }],
      moved: { engrams: 2, entries: 2, relations: 0 },
      created: { projects: ['top', 'child'], entities: [], users: [], agents: [], tags: [], subjects: [] },
      legacy: { engrams: 0, entries: 0, agents: [] },
      collisions: [],
    })
    expect(r.body.crossing).toEqual([{ id: expect.any(String), relation: 'related_to', direction: 'out', other: { id: ids.outside, type: 'note', title: 'outside' } }])
    expect(r.body.plan_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.body.payload_bytes).toBeGreaterThan(1000)
    // the same state, the same plan
    expect((await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })).body).toEqual(r.body)

    const toPrivate = await post(own.tokenPlaintext, '/move/plan', { target: other.brainId, project: 'top' })
    expect(toPrivate.status).toBe(200)
    expect(toPrivate.body.collisions).toEqual(['the target is not a team brain of this cockpit; a project moves into a shared space'])
    expect(await post(own.tokenPlaintext, '/move/plan', { target: '00000000-0000-4000-8000-000000000000', project: 'top' })).toMatchObject({ status: 404, body: { code: 'TARGET_NOT_FOUND' } })
    expect(await post(own.tokenPlaintext, '/move/plan', { target: own.brainId, project: 'top' })).toMatchObject({ status: 400, body: { code: 'INVALID_TARGET' } })
    expect(await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'nowhere' })).toMatchObject({ status: 404 })
    expect(await post(own.tokenPlaintext, '/move/plan', { target: BRAIN })).toMatchObject({ status: 400, body: { code: 'INVALID_PROJECT' } })
  })

  it('refuses a run against a target that is no team brain, a stale plan, and a team brain as the source', async () => {
    const plan = (await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })).body
    const before = opLog(own.brainFile)
    expect(await post(own.tokenPlaintext, '/move', { target: other.brainId, project: 'top', plan_hash: plan.plan_hash })).toMatchObject({ status: 409, body: { code: 'MOVE_REFUSED', error: 'move refused: the target is not a team brain of this cockpit; a project moves into a shared space. Nothing was moved.' } })
    expect(await post(own.tokenPlaintext, '/move', { target: BRAIN, project: 'top', plan_hash: 'f'.repeat(64) })).toMatchObject({ status: 409, body: { code: 'PLAN_CHANGED', plan_hash: plan.plan_hash } })
    expect(await post(own.tokenPlaintext, '/move', { target: BRAIN, project: 'top', plan_hash: 'stale' })).toMatchObject({ status: 400, body: { code: 'INVALID_PLAN' } })
    expect(await post(own.tokenPlaintext, '/move', { target: BRAIN, project: 'top', plan_hash: plan.plan_hash, target_name: 5 })).toMatchObject({ status: 400, body: { code: 'INVALID_TARGET_NAME' } })
    expect(await post(tokens[BRAIN], '/move', { target: own.brainId, project: 'top', plan_hash: plan.plan_hash })).toMatchObject({ status: 409, body: { code: 'MOVE_REFUSED' } })
    expect(opLog(own.brainFile)).toBe(before)
    expect(relay.log.filter(e => e.seq > 1)).toEqual([])
    // a refused move writes no backup
    expect(existsSync(join(tmpDir, 'backups', 'move'))).toBe(false)
  })

  it('the relay takes the import but no answer comes in time: 504 SHARED_WRITE_PENDING, nothing removed; confirmed again once it landed, the move resumes without a second import', async () => {
    const plan = (await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })).body
    const before = opLog(own.brainFile)
    // the relay keeps the import and sends no answer: the move waits until its deadline, whatever the machine's speed
    relay.hold = true
    const move = post(own.tokenPlaintext, '/move', { target: BRAIN, project: 'top', plan_hash: plan.plan_hash })
    // meanwhile a write to the source is refused at once (BRAIN_BUSY, not the lock's busy timeout), nothing written, reads still work
    for (let i = 0; i < 100 && !relay.log.some(e => e.seq > 1); i++) await new Promise(resolve => setTimeout(resolve, 20))
    expect(relay.log.filter(e => e.seq > 1)).toHaveLength(1)
    const during = flat(validNote({ scope: 'project.elsewhere', title: 'during-the-move' }))
    const refused = await post(own.tokenPlaintext, `/engram/${during.type}`, during.body)
    expect(refused).toMatchObject({ status: 503, body: { code: 'BRAIN_BUSY', error: 'This brain is busy right now: a project is being moved out of it. Reads still work; try the write again in a moment.' } })
    expect((await get(own.tokenPlaintext, `/engram/${ids.outside}`)).status).toBe(200)
    expect(await post(own.tokenPlaintext, '/move', { target: BRAIN, project: 'top', plan_hash: plan.plan_hash })).toMatchObject({ status: 409, body: { code: 'MOVE_REFUSED', error: 'move refused: a move out of this brain is under way. Nothing was moved.' } })
    const pending = await move
    expect(pending).toMatchObject({ status: 504, body: { code: 'SHARED_WRITE_PENDING' } })
    expect(opLog(own.brainFile)).toBe(before)
    // the move let go: the source takes writes again
    const after = flat(validNote({ scope: 'project.elsewhere', title: 'after-the-pending-move' }))
    expect((await post(own.tokenPlaintext, `/engram/${after.type}`, after.body)).status).toBe(201)
    expect((await get(own.tokenPlaintext, '/project/top')).body.project.status).toBe('active')
    // the plan is the same: the source did not change
    expect((await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })).body.plan_hash).toBe(plan.plan_hash)
    // the import landed in the relay's log; the connection drops, the sync reconnects and the replica takes it
    const imports = relay.log.filter(e => e.seq > 1)
    expect(imports).toHaveLength(1)
    relay.hold = false
    relay.closeAll()
    const live = async () => (await get(tokens[BRAIN], '/team')).body.state.kind === 'live' && (await get(tokens[BRAIN], `/engram/${ids.task}`)).status === 200
    for (let i = 0; i < 100 && !(await live()); i++) await new Promise(resolve => setTimeout(resolve, 100))
    expect(await live()).toBe(true)
    // the plan a reopened dialog reads: the same plan, a resume of that import, nothing to refuse
    const resumed = (await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })).body
    expect(resumed).toMatchObject({ plan_hash: plan.plan_hash, resume: { seq: imports[0].seq, op_id: imports[0].opId }, collisions: [] })

    // the cockpit's name for the space travels with the confirmed run: control and format characters (a bidi override) go, whitespace collapses, the length is capped
    const name = ('Team brain ' + 'x'.repeat(100)).slice(0, 80)
    const r = await post(own.tokenPlaintext, '/move', { target: BRAIN, project: 'top', plan_hash: plan.plan_hash, target_name: '  Team\u0007 \n \u202Ebrain ' + 'x'.repeat(100) })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({
      project: 'top', tree: plan.tree, archived: ['top', 'child'], moved: plan.moved, resumed: true,
      import: { seq: imports[0].seq, op_id: imports[0].opId },
      created: { projects: [], entities: [], users: [], agents: [], tags: [], subjects: [] },
      dropped_relations: plan.crossing.map((c: { id: string }) => c.id),
    })
    ids.import = r.body.import.op_id
    // the agent brain's reference names the team brain now; the other private brain held none
    expect(r.body.references).toEqual([{ brain: agent.brainId, relations: 1 }])
    const lesson = await get(agent.tokenPlaintext, `/engram/${ids.lesson}?with_relations=true`)
    expect(lesson.body.relations).toEqual([expect.objectContaining({ target_id: ids.task, source_brain: null, target_brain: BRAIN })])
    expect(r.body.ids).toEqual([ids.task, ids.note])
    // still the one import in the relay's log
    expect(relay.log.filter(e => e.seq > 1)).toHaveLength(1)
    // the set is in the team brain, readable, as it was
    const task = await get(tokens[BRAIN], `/engram/${ids.task}`)
    expect(task.status).toBe(200)
    // as it was written in the source: its author, not the member who imported it
    expect(task.body).toMatchObject({ scope: 'project.top', title: 'hub', ingested_by: ids.author })
    expect(ids.author).not.toBe('juno')
    expect(task.body.entries.map((e: { text: string }) => e.text)).toContain('progress')
    expect((await get(tokens[BRAIN], '/project/child')).body.project.parent_project).toBe('top')
    // gone from the source; its projects archived and pointing at the team brain; the crossing link dropped
    expect((await get(own.tokenPlaintext, `/engram/${ids.task}`)).status).toBe(404)
    const top = (await get(own.tokenPlaintext, '/project/top')).body.project
    expect(top).toMatchObject({ status: 'archived', metadata: { moved_to: BRAIN, moved_at: expect.stringMatching(/^\d{4}-/), moved_to_name: name } })
    expect((await get(own.tokenPlaintext, '/project/child')).body.project.metadata).toMatchObject({ moved_to: BRAIN, moved_to_name: name })
    // what an agent sees of the moved project: the one line under the header
    const shown = (await get(own.tokenPlaintext, '/brain-state?scope=project.top')).body.markdown as string
    expect(shown).toContain(`# project.top — brain state\n_Moved to the shared space ${name} on ${top.metadata.moved_at.slice(0, 10)} — its engrams live there; nothing new is filed here._\n`)
    expect(shown).not.toContain('moved_')
    expect((await get(own.tokenPlaintext, `/engram/${ids.outside}?with_relations=true`)).body.relations).toEqual([])
    // the note after the pending move, then move_out and two archive ops in the source's log; a backup of the source before the move
    expect(opLog(own.brainFile)).toBe(before + 4)
    expect(opLog(own.brainFile, `SELECT COUNT(*) AS n FROM op_log WHERE json_extract(payload, '$.call') = 'engram.move_out'`)).toBe(1)
    // one backup per attempt that got past the plan: the lost answer and the resume
    const backups = readdirSync(join(tmpDir, 'backups', 'move')).sort()
    expect(backups).toEqual([expect.stringMatching(new RegExp(`^${own.brainId}-\\d{4}-\\d{2}-\\d{2}T.*\\.db$`)), expect.stringMatching(/\.db$/)])
    expect(r.body.backup_path).toBe(join(tmpDir, 'backups', 'move', backups[1]))
    expect(existsSync(r.body.backup_path)).toBe(true)
    // nothing of the move in the server's error output
    expect(stderr).not.toMatch(/move/i)
  }, 20000)

  it('a moved project has nothing left to move', async () => {
    expect(await post(own.tokenPlaintext, '/move/plan', { target: BRAIN, project: 'top' })).toMatchObject({ status: 400, body: { error: 'Invalid move: project top has no engrams to move.' } })
  })
})
