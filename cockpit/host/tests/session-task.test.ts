import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  const setup = (space: { shared: boolean | null }, brain = fakeBrain()) => {
    const ledger = new mods.SessionLedger()
    const spaces = { resolve: () => space as never }
    const tasks = mods.createSessionTask({ ledger, spaces, brain: () => brain, now: () => new Date('2026-11-17T10:00:00Z') })
    return { ledger, brain, tasks }
  }
  const id = (n: number) => `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`

  it('gives a session without a task a placeholder task in its project, once, and tells it the handoff', async () => {
    const { ledger, brain, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(1), null, 'bp-eml', 'claude')
    const [first, second] = await Promise.all([tasks.context(id(1)), tasks.context(id(1))])
    expect(brain.posts.filter((p) => p.path === '/engram/task')).toHaveLength(1)
    expect(brain.posts[0].body).toMatchObject({ scope: 'project.eml', status: 'active', title: 'session-2026-11-17-00000001' })
    expect(ledger.get(id(1))).toMatchObject({ taskId: 't1', taskAuto: true })
    expect(first).toBe(second)
    expect(first).toContain('**session-2026-11-17-00000001** · t1 [active]')
    expect(first).toContain('takes the session\'s name')
    expect(first).toContain('### Handoff')
    expect(first).toContain('- [lasse]')
  })

  it('gives a worker a task of its own that notes who started it, a step only when asked, and global for a project the brain does not know', async () => {
    const { ledger, brain, tasks } = setup({ shared: false }, fakeBrain(['global', 'project.eml']))
    ledger.recordSpawn(id(2), null, 'bp-eml', 'claude', false, 'parent-task')
    ledger.setAgentTitle(id(2), 'Email Lord')
    ledger.expectParent(id(3), id(2))
    ledger.recordSpawn(id(3), null, 'bp-unknown', 'claude', true)
    await tasks.context(id(3))
    let created = brain.posts.filter((p) => p.path === '/engram/task')
    expect(created.map((p) => p.body.scope)).toEqual(['project.unknown', 'global'])
    expect(created[1].body).not.toHaveProperty('parent_id')
    expect(created[1].body.content).toContain('Started by session Email Lord (its task parent-task)')

    ledger.expectParent(id(4), id(2))
    ledger.expectTaskParent(id(4), 'parent-task')
    ledger.recordSpawn(id(4), null, 'bp-eml', 'claude', true)
    await tasks.context(id(4))
    created = brain.posts.filter((p) => p.path === '/engram/task')
    expect(created.at(-1)!.body.parent_id).toBe('parent-task')
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

  it('gives a job\'s session the job\'s task', async () => {
    const brain = fakeBrain()
    brain.tasks.set('weekly', { id: 'weekly', title: 'weekly-report', content: 'Write it.', status: 'active', properties: {} })
    const ledger = new mods.SessionLedger()
    const tasks = mods.createSessionTask({ ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, jobTask: (jobId) => (jobId === 'job-1' ? 'weekly' : null) })
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

  it('asks only an attended session for its handoff before an idle stop, and tells it not to end every reply with one', async () => {
    const { ledger, tasks } = setup({ shared: false })
    ledger.recordSpawn(id(9), null, 'bp-eml', 'claude')
    ledger.recordSpawn('worker-1', null, 'bp-eml', 'claude', true)
    const own = await tasks.context(id(9))
    const worker = await tasks.context('worker-1')
    expect(own).toContain('Do not end every reply with it')
    expect(worker).toContain('When you stop (done, or waiting for someone)')
    expect(tasks.handoffBeforeStop(id(9))).toContain('write your handoff block now')
    expect(tasks.handoffBeforeStop('worker-1')).toBeNull()
    ledger.recordSpawn('no-task', null, 'bp-eml', 'claude')
    expect(tasks.handoffBeforeStop('no-task')).toBeNull()
  })

  it('shows the task\'s goal, asks for one when it is missing, and gives only workers the follow-up rules', async () => {
    const brain = fakeBrain()
    brain.tasks.set('t-dw', { id: 't-dw', title: 'acme-rescue', content: 'Win Acme back.', status: 'active', properties: { goal: 'Kim confirmed the cancellation is withdrawn' } })
    brain.tasks.set('t-none', { id: 't-none', title: 'other', content: 'Other work.', status: 'active', properties: {} })
    const { ledger, tasks } = setup({ shared: false }, brain)
    ledger.recordSpawn('worker-dw', null, 'bp-eml', 'claude', true, 't-dw')
    ledger.recordSpawn(id(8), null, 'bp-eml', 'claude', false, 't-none')
    const worker = await tasks.context('worker-dw')
    expect(worker).toContain('Goal: Kim confirmed the cancellation is withdrawn')
    expect(worker).toContain('## Until it is done')
    expect(worker).toContain('schedule your next check yourself')
    const own = await tasks.context(id(8))
    expect(own).toContain('Goal: not set yet')
    expect(own).not.toContain('## Until it is done')
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
