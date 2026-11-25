import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BEFORE_IDLE_STOP } from '../src/domain/turn-end.js'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-task-'))
process.env.EML_COCKPIT_HOME = home

type Mods = {
  SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
  createSessionTask: typeof import('../src/application/session-task.js')['createSessionTask']
  kebabTitle: typeof import('../src/application/session-task.js')['kebabTitle']
}

/** A brain that keeps tasks in memory and refuses scopes it does not know, like the real one. */
function fakeBrain(knownScopes = ['global', 'project.eml']) {
  const tasks = new Map<string, Record<string, unknown>>()
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let next = 1
  return {
    tasks, posts,
    async get(path: string) {
      const task = tasks.get(path.slice('/engram/'.length))
      if (!task) throw new Error('engram not found')
      return task
    },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      if (path === '/engram/task') {
        if (!knownScopes.includes(body.scope as string)) throw new Error(`unknown scope ${String(body.scope)}`)
        const task = { id: `t${next++}`, status: 'planned', properties: {}, ...body }
        tasks.set(task.id, task)
        return task
      }
      const id = /^\/task\/([^/]+)\/track$/.exec(path)![1]
      tasks.set(id, { ...tasks.get(id), ...body })
      return tasks.get(id)
    },
  }
}

describe('session task', () => {
  let mods: Mods
  beforeAll(async () => {
    const ledger = await import('../src/session-ledger.js')
    const task = await import('../src/application/session-task.js')
    mods = { SessionLedger: ledger.SessionLedger, createSessionTask: task.createSessionTask, kebabTitle: task.kebabTitle }
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  /** Whether the provider's chat sessions have the end_turn tool. */
  const tool = { chat: true }
  const setup = (space: { shared: boolean | null }, brain = fakeBrain()) => {
    const ledger = new mods.SessionLedger()
    const spaces = { resolve: () => space as never }
    const tasks = mods.createSessionTask({ ledger, spaces, brain: () => brain, me: 'lasse', endTurnTool: (id) => ledger.get(id)?.runtime === 'sdk' && tool.chat, now: () => new Date('2026-11-17T10:00:00Z') })
    return { ledger, brain, tasks }
  }
  const id = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`

  it('hands a spawned worker\'s new task to the space\'s agent with checkpoint none, held off the runner until the worker has it', async () => {
    const { createWorkerTaskHolds } = await import('../src/application/worker-task.js')
    const ledger = new mods.SessionLedger()
    const [starter, worker, own] = ['f0000001', 'f0000002', 'f0000003'].map((p) => `${p}-aaaa-bbbb-cccc-dddddddddddd`)
    const brain = fakeBrain()
    const holds = createWorkerTaskHolds()
    const tasks = mods.createSessionTask({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, me: 'lasse', endTurnTool: () => false,
      now: () => new Date('2026-11-17T10:00:00Z'), workerDelegate: () => 'atlas', workerHolds: holds,
    })
    ledger.expectParent(worker, starter)
    ledger.recordSpawn(worker, null, 'bp-eml', 'claude', true)
    await tasks.context(worker)
    // requested at the session's creation, not at its first hook: the run it writes (started then) closes the request
    const createdAt = ledger.get(worker)!.createdAt
    expect(brain.posts[0].body).toMatchObject({ delegation: { agent: 'atlas', checkpoint: 'none', requested_at: createdAt } })
    const { requestOpen } = await import('../src/domain/delegation.js')
    const posted = { status: 'active', properties: { delegation: brain.posts[0].body.delegation as never } }
    expect(requestOpen(posted, null)).toBe(true)
    expect(requestOpen(posted, createdAt)).toBe(false)
    expect(holds.holds(ledger.get(worker)!.taskId!)).toBe(true)
    // the user's own session, a worker the runner started (no parent) and a job's run get no delegate from here
    ledger.recordSpawn(own, null, 'bp-eml', 'claude')
    await tasks.context(own)
    expect(brain.posts.at(-1)!.body).not.toHaveProperty('delegation')
    const [runnerWorker, jobRun] = ['f0000004', 'f0000005'].map((p) => `${p}-aaaa-bbbb-cccc-dddddddddddd`)
    ledger.recordSpawn(runnerWorker, null, 'bp-eml', 'claude', true)
    await tasks.context(runnerWorker)
    expect(brain.posts.at(-1)!.body).not.toHaveProperty('delegation')
    ledger.expectParent(jobRun, starter)
    ledger.recordSpawn(jobRun, null, 'bp-eml', 'claude', true)
    ledger.setJobId(jobRun, 'job-1')
    const before = brain.posts.length
    await tasks.context(jobRun)
    expect(brain.posts.slice(before).filter((p) => p.path === '/engram/task').every((p) => !('delegation' in p.body))).toBe(true)
  })

  it('gives a session without a task a placeholder task in its project, once, and tells it the handoff', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(1), null, 'bp-eml', 'claude')
    const [first, second] = await Promise.all([tasks.context(id(1)), tasks.context(id(1))])
    expect(brain.posts.filter((p) => p.path === '/engram/task')).toHaveLength(1)
    expect(brain.posts[0].body).toMatchObject({ scope: 'project.eml', status: 'active', title: 'session-2026-11-17-00000001', assignee_ids: ['lasse'] })
    expect(ledger.get(id(1))).toMatchObject({ taskId: 't1', taskAuto: true })
    expect(first).toBe(second)
    expect(first).toContain('**session-2026-11-17-00000001** · t1 [active]')
    expect(first).toContain('give it its name as above')
    expect(first).toContain('calls this session by its task\'s name')
    expect(first).toContain('### Handoff')
    expect(first).toContain('- [lasse]')
  })

  it('gives a worker a task of its own that notes who started it, a step only when asked, and the requester\'s project and owners for a project the brain does not know', async () => {
    const { ledger, brain, tasks } = setup({ shared: false }, fakeBrain(['global', 'project.eml']))
    brain.tasks.set('parent-task', { id: 'parent-task', scope: 'project.eml', properties: { assignee_ids: ['dominik'] } })
    ledger.recordSpawn(id(2), null, 'bp-eml', 'claude', false, 'parent-task')
    ledger.setAgentTitle(id(2), 'Email Lord')
    ledger.expectParent(id(3), id(2))
    ledger.recordSpawn(id(3), null, 'bp-unknown', 'claude', true)
    await tasks.context(id(3))
    let created = brain.posts.filter((p) => p.path === '/engram/task')
    expect(created.map((p) => p.body.scope)).toEqual(['project.unknown', 'project.eml'])
    expect(created[1].body.assignee_ids).toEqual(['dominik'])
    expect(created[1].body).not.toHaveProperty('parent_id')
    expect(created[1].body.content).toContain('Started by session Email Lord (its task parent-task)')

    ledger.expectParent(id(4), id(2))
    ledger.expectTaskParent(id(4), 'parent-task')
    ledger.recordSpawn(id(4), null, 'bp-eml', 'claude', true)
    await tasks.context(id(4))
    created = brain.posts.filter((p) => p.path === '/engram/task')
    expect(created.at(-1)!.body.parent_id).toBe('parent-task')
  })

  it('makes no task outside every project: a folder-only project without a task to take one from leaves the session without one', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(7), null, 'folder-abc', 'claude')
    expect(await tasks.context(id(7))).toBe('')
    expect(brain.posts.filter((p) => p.path === '/engram/task')).toHaveLength(0)
    expect(ledger.get(id(7))?.taskId ?? null).toBeNull()
  })

  it('keeps a task the session was started with, and does not mark it as created by the cockpit', async () => {
    const brain = fakeBrain()
    brain.tasks.set('given', { id: 'given', title: 'homepage-v4b', content: 'Build it.', status: 'active', properties: { stage: 'implementation' } })
    const { ledger, tasks } = setup({ shared: false }, brain)
    ledger.recordSpawn(id(14), null, 'bp-eml', 'claude', false, 'given')
    const text = await tasks.context(id(14))
    expect(brain.posts).toHaveLength(0)
    expect(text).toContain('**homepage-v4b** · given [active · implementation]')
    expect(text).not.toContain('takes the session\'s name')
    expect(ledger.get(id(14))!.taskAuto).toBeUndefined()
  })

  it('tells a step its parent\'s name and goal, and leaves out a parent it cannot read', async () => {
    const brain = fakeBrain()
    brain.tasks.set('rescue', { id: 'rescue', title: 'acme-rescue', content: 'Keep Acme.', status: 'active', properties: { display_title: 'Keep Acme as a customer', goal: 'Acme renewed.' } })
    brain.tasks.set('step', { id: 'step', title: 'acme-call-notes', content: 'Sum up the call.', status: 'active', properties: {}, relations: [{ relation: 'part_of', source_id: 'step', target_id: 'rescue' }] })
    brain.tasks.set('orphan', { id: 'orphan', title: 'lost-step', content: 'A step.', status: 'active', properties: {}, relations: [{ relation: 'part_of', source_id: 'orphan', target_id: 'gone' }] })
    const { ledger, tasks } = setup({ shared: false }, brain)
    ledger.recordSpawn(id(15), null, 'bp-eml', 'claude', true, 'step')
    expect(await tasks.context(id(15))).toContain('Step of **Keep Acme as a customer** (rescue). Parent goal: Acme renewed.')
    ledger.recordSpawn(id(16), null, 'bp-eml', 'claude', true, 'orphan')
    const orphan = await tasks.context(id(16))
    expect(orphan).toContain('**lost-step** · orphan')
    expect(orphan).not.toContain('Step of')
  })

  it('gives a job\'s session the job\'s task', async () => {
    const brain = fakeBrain()
    brain.tasks.set('weekly', { id: 'weekly', title: 'weekly-report', content: 'Write it.', status: 'active', properties: {} })
    const ledger = new mods.SessionLedger()
    const tasks = mods.createSessionTask({ ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, me: 'lasse', endTurnTool: () => false, jobTask: (jobId) => (jobId === 'job-1' ? 'weekly' : null) })
    ledger.recordSpawn(id(7), null, 'bp-eml', 'claude', true)
    ledger.setJobId(id(7), 'job-1')
    expect(await tasks.context(id(7))).toContain('**weekly-report** · weekly')
    expect(brain.posts).toHaveLength(0)
    expect(ledger.get(id(7))!.taskId).toBe('weekly')
  })

  it('gives a session its task in a shared space too', async () => {
    const { ledger, brain, tasks } = setup({ shared: true })
    ledger.recordSpawn(id(5), null, 'bp-eml', 'claude')
    expect(await tasks.context(id(5))).toContain('### Handoff')
    expect(brain.posts.filter((p) => p.path === '/engram/task')).toHaveLength(1)
    expect(ledger.get(id(5))!.taskId).not.toBeNull()
  })

  it('names the placeholder after the session, and leaves a task the session renamed itself', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(6), null, 'bp-eml', 'claude')
    await tasks.context(id(6))
    await tasks.named(id(6), 'Größe der Seite prüfen')
    expect(brain.tasks.get('t1')).toMatchObject({ title: 'grosse-der-seite-prufen', content: `Größe der Seite prüfen (cockpit session ${id(6)}).`, text: 'Named after its session.' })
    await tasks.named(id(6), 'Another name')
    expect(brain.tasks.get('t1')!.title).toBe('grosse-der-seite-prufen')
    // The task survives a respawn as the cockpit's own.
    ledger.recordSpawn(id(6), 'pane', 'bp-eml', 'claude')
    expect(ledger.get(id(6))!.taskAuto).toBe(true)
  })

  it('does not name a task that has a display title, even with the placeholder anchor', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(20), null, 'bp-eml', 'claude')
    await tasks.context(id(20))
    brain.tasks.set('t1', { ...brain.tasks.get('t1'), properties: { display_title: 'Fix the stock answers' } })
    await tasks.named(id(20), 'Something else')
    expect(brain.posts.filter((p) => p.path === '/task/t1/track')).toHaveLength(0)
  })

  it('renames the task when the user renames the session, and gives a placeholder its anchor too', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(21), null, 'bp-eml', 'claude')
    await tasks.context(id(21))
    expect(await tasks.renamed(id(21), 'Check the page size')).toBe(true)
    expect(brain.posts.at(-1)).toMatchObject({ path: '/task/t1/track', body: { display_title: 'Check the page size', title: 'check-the-page-size', text: 'Renamed from its session\'s heading in the cockpit.' } })
    // a named task keeps its anchor; a lowercase word still becomes the name
    expect(await tasks.renamed(id(21), 'pagesize')).toBe(true)
    expect(brain.posts.at(-1)!.body).toEqual({ display_title: 'pagesize', text: 'Renamed from its session\'s heading in the cockpit.' })
    // the same name again writes nothing
    const posts = brain.posts.length
    brain.tasks.set('t1', { ...brain.tasks.get('t1'), properties: { display_title: 'pagesize' } })
    expect(await tasks.renamed(id(21), 'pagesize')).toBe(true)
    expect(brain.posts).toHaveLength(posts)
    // a session without a task has nothing to rename
    ledger.recordSpawn(id(22), null, 'bp-eml', 'claude')
    expect(await tasks.renamed(id(22), 'Anything')).toBe(false)
  })

  it('names the placeholder at start when the session had its name before its task', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(8), null, 'bp-eml', 'claude')
    ledger.setAgentTitle(id(8), 'Email Lord')
    const text = await tasks.context(id(8))
    expect(brain.tasks.get('t1')!.title).toBe('email-lord')
    // the anchor is the kebab; the name people read is the session's whole name
    expect(brain.posts.find((p) => p.path === '/task/t1/track')?.body).toMatchObject({ title: 'email-lord', display_title: 'Email Lord' })
    expect(text).toContain('**email-lord** · t1')
    expect(text).not.toContain('takes the session\'s name')
  })

  it('asks only an attended session where its task stands before an idle stop, and tells every session how a turn ends', async () => {
    const { ledger, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(9), null, 'bp-eml', 'claude')
    ledger.recordSpawn('worker-1', null, 'bp-eml', 'claude', true)
    ledger.setRuntime('worker-1', 'sdk')
    const own = await tasks.context(id(9))
    const worker = await tasks.context('worker-1')
    // A terminal has no end_turn tool: it reads the block. A chat session of Claude reads only where the rule is.
    expect(own).toContain('## Ending a turn\nEnd your reply with this block when you stop and the stop changes who has to act or where the task stands.')
    expect(own).toContain('Write no block for a turn that is plain conversation.')
    expect(own).toContain('Handles for who: the user is lasse')
    expect(worker).toContain('## Ending a turn\nThe end_turn tool\'s description is the whole rule for ending a turn.')
    expect(worker).not.toContain('### Handoff')
    for (const text of [own, worker]) expect(text).not.toContain('session_status')
    expect(tasks.handoffBeforeStop(id(9))).toBe(BEFORE_IDLE_STOP)
    expect(tasks.handoffBeforeStop('worker-1')).toBeNull()
    ledger.recordSpawn('no-task', null, 'bp-eml', 'claude')
    expect(tasks.handoffBeforeStop('no-task')).toBeNull()
  })

  it('does not point a chat session at end_turn when its provider\'s chat has no such tool', async () => {
    const { ledger, tasks } = setup({ shared: false })
    ledger.recordSpawn('other-chat', null, 'bp-eml', 'codex', true)
    ledger.setRuntime('other-chat', 'sdk')
    tool.chat = false
    try {
      const text = await tasks.context('other-chat')
      expect(text).toContain('## Ending a turn\nEnd your reply with this block when you stop')
      expect(text).toContain('### Handoff')
      expect(text).not.toContain('end_turn')
    } finally {
      tool.chat = true
    }
  })

  it('shows the task\'s goal, asks for one when it is missing, and gives the follow-up rules by the task\'s delegate', async () => {
    const brain = fakeBrain()
    brain.tasks.set('t-dw', { id: 't-dw', title: 'acme-rescue', content: 'Win Acme back.', status: 'active', properties: { goal: 'Kim confirmed the cancellation is withdrawn', delegate: 'atlas' } })
    brain.tasks.set('t-none', { id: 't-none', title: 'other', content: 'Other work.', status: 'active', properties: {} })
    const { ledger, tasks } = setup({ shared: false }, brain)
    ledger.recordSpawn('worker-dw', null, 'bp-eml', 'claude', true, 't-dw')
    ledger.recordSpawn(id(8), null, 'bp-eml', 'claude', false, 't-dw')
    ledger.recordSpawn('worker-none', null, 'bp-eml', 'claude', true, 't-none')
    const worker = await tasks.context('worker-dw')
    expect(worker).toContain('Goal: Kim confirmed the cancellation is withdrawn')
    expect(worker).toContain('## Until it is done')
    expect(worker).toContain('name yourself as next, with the time you look again')
    // The user's own session on the handed-over task reads them too; a worker on a task that is not handed over does not.
    expect(await tasks.context(id(8))).toContain('## Until it is done')
    const none = await tasks.context('worker-none')
    expect(none).toContain('Goal: not set yet')
    expect(none).not.toContain('## Until it is done')
  })

  it('turns a title into a kebab-case anchor', () => {
    expect(mods.kebabTitle('Task system: M1 — hooks!')).toBe('task-system-m1-hooks')
    expect(mods.kebabTitle('✨')).toBeNull()
    expect(mods.kebabTitle('a'.repeat(80))).toHaveLength(60)
  })
})

describe('the task hook', () => {
  const HOOK = join(__dirname, '..', 'src', 'task-hook.ts')
  const runHook = (env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const { COCKPIT_URL: _url, COCKPIT_SPAWN_TOKEN: _token, COCKPIT_SESSION_ID: _session, ...rest } = process.env
    const child = spawn(process.execPath, ['--import', 'tsx', HOOK], { env: { ...rest, ...env }, stdio: ['pipe', 'pipe', 'inherit'] })
    let out = ''
    child.stdout.on('data', (c) => { out += c })
    child.on('close', (code) => resolve({ code, out }))
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup' }))
  })
  const withHost = async (status: number, body: string, run: (url: string, seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }>) => Promise<void>) => {
    const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = []
    const host = createServer((req, res) => { seen.push({ method: req.method, url: req.url, headers: req.headers }); res.statusCode = status; res.end(body) })
    await new Promise<void>((r) => host.listen(0, '127.0.0.1', r))
    try { await run(`http://127.0.0.1:${(host.address() as AddressInfo).port}`, seen) } finally { host.close() }
  }

  it('prints the host\'s task context as SessionStart context', async () => {
    await withHost(200, JSON.stringify({ text: '# Your task' }), async (url, seen) => {
      const { code, out } = await runHook({ COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: 'token-1', COCKPIT_SESSION_ID: 'session-1' })
      expect(code).toBe(0)
      expect(JSON.parse(out)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: '# Your task' } })
      expect(seen[0]).toMatchObject({ method: 'POST', url: '/api/session-task' })
      expect(seen[0].headers['x-cockpit-token']).toBe('token-1')
      expect(seen[0].headers['x-cockpit-session']).toBe('session-1')
    })
  })

  it('prints nothing when the task system is off, the host refuses or is gone', async () => {
    await withHost(200, JSON.stringify({ text: '' }), async (url) => {
      expect(await runHook({ COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' })).toEqual({ code: 0, out: '' })
    })
    await withHost(403, '{}', async (url) => {
      expect(await runHook({ COCKPIT_URL: url, COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' })).toEqual({ code: 0, out: '' })
    })
    expect(await runHook({ COCKPIT_URL: 'http://127.0.0.1:1', COCKPIT_SPAWN_TOKEN: 't', COCKPIT_SESSION_ID: 's' })).toEqual({ code: 0, out: '' })
    expect(await runHook({})).toEqual({ code: 0, out: '' })
  })
})
