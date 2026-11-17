import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-task-router-'))
process.env.EML_COCKPIT_HOME = home

type Router = typeof import('../src/application/task-router.js')
type HandoffMod = typeof import('../src/domain/handoff.js')
type Ledger = typeof import('../src/session-ledger.js')['SessionLedger']

const HANDOFF = `Done, the page is built.

### Handoff
Result: Homepage v4b hero built on the canvas.
Checked: copy rules R1–R10 · Claimed: the prices from the brief
Decided: kept the old CTA
Next: review by Lasse
Questions:
- [lasse] Ship the shorter headline?
- [task] Do we need a German variant?`

function fakeBrain(task: Record<string, unknown>) {
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  return {
    posts, task,
    async get() { return task },
    async post(path: string, body: Record<string, unknown>) {
      posts.push({ path, body })
      if ('waiting_on' in body) {
        const props = { ...(task.properties as object) } as Record<string, unknown>
        if (body.waiting_on === null) delete props.waiting_on
        else props.waiting_on = body.waiting_on
        task.properties = props
      }
      return task
    },
  }
}

describe('handoff', () => {
  let mod: HandoffMod
  beforeAll(async () => { mod = await import('../src/domain/handoff.js') })

  it('reads the last handoff block of a message', () => {
    const h = mod.parseHandoff(`### Handoff\nResult: old\n\n${HANDOFF}`)!
    expect(h.result).toBe('Homepage v4b hero built on the canvas.')
    expect(h.next).toBe('review by Lasse')
    expect(h.forUser).toEqual(['Ship the shorter headline?'])
    expect(h.forTask).toEqual(['Do we need a German variant?'])
    expect(h.text.startsWith('### Handoff\nResult: Homepage')).toBe(true)
  })

  it('reads a block in a code fence, with bold labels, untagged and empty questions', () => {
    const h = mod.parseHandoff('Text\n```\n## Handoff\n**Result:** ok\nQuestions:\n1. Which colour?\n- none\n```\nAfter the fence')!
    expect(h.result).toBe('ok')
    expect(h.forUser).toEqual(['Which colour?'])
    expect(h.text).not.toContain('After the fence')
    expect(mod.parseHandoff('### Handoff\nResult: done\nQuestions: none')!.forUser).toEqual([])
  })

  it('finds none in a message without the heading', () => {
    expect(mod.parseHandoff('Result: done, no block here')).toBeNull()
  })
})

describe('task router', () => {
  let router: Router
  let SessionLedger: Ledger
  beforeAll(async () => {
    router = await import('../src/application/task-router.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  const setup = (task: Record<string, unknown>, space = { taskSystem: true, shared: false }) => {
    const ledger = new SessionLedger()
    const brain = fakeBrain(task)
    const waited: string[] = []
    const logs: string[] = []
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => space as never }, brain: () => brain, owner: 'lasse',
      waiting: (id) => waited.push(id), log: (l) => logs.push(l), now: () => new Date('2026-11-17T09:00:00Z'),
    })
    return { ledger, brain, r, waited, logs }
  }

  it('puts the task on the user for a [lasse] question, writes the handoff once, and marks the session as waiting', async () => {
    const { ledger, brain, r, waited } = setup({ id: 't1', status: 'active', properties: {} })
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', false, 't1')
    await r.turnEnded('s1', HANDOFF)
    await r.turnEnded('s1', HANDOFF)
    expect(brain.posts).toHaveLength(1)
    expect(brain.posts[0].path).toBe('/task/t1/track')
    expect(brain.posts[0].body.text).toContain('Result: Homepage v4b hero')
    expect(brain.posts[0].body.waiting_on).toEqual({ who: 'lasse', why: 'Ship the shorter headline?', since: '2026-11-17T09:00:00.000Z', session_id: 's1' })
    expect(ledger.get('s1')!.attention).toMatchObject({ kind: 'question', reason: 'Ship the shorter headline?' })
    expect(waited).toEqual(['s1'])
  })

  it('clears its own wait when the next handoff has no question, and leaves another session\'s', async () => {
    const { ledger, brain, r } = setup({ id: 't2', status: 'active', properties: { waiting_on: { who: 'lasse', why: 'old', since: 'x', session_id: 's2' } } })
    ledger.recordSpawn('s2', null, 'bp-eml', 'claude', false, 't2')
    ledger.recordSpawn('s3', null, 'bp-eml', 'claude', false, 't2')
    await r.turnEnded('s3', '### Handoff\nResult: side work done')
    expect(brain.posts.at(-1)!.body).toEqual({ text: '### Handoff\nResult: side work done' })
    await r.turnEnded('s2', '### Handoff\nResult: answered and finished')
    expect(brain.posts.at(-1)!.body.waiting_on).toBeNull()
  })

  it('routes a failed session and a step with checkpoint after that handed over a result', async () => {
    const failed = setup({ id: 't3', status: 'active', properties: {} })
    failed.ledger.recordSpawn('s4', null, 'bp-eml', 'claude', true, 't3')
    failed.ledger.setAttention('s4', { kind: 'failed', reason: 'Build broke' })
    await failed.r.turnEnded('s4', 'No block')
    expect(failed.brain.posts[0].body).toEqual({ waiting_on: expect.objectContaining({ why: 'Build broke' }) })
    expect(failed.waited).toEqual([])

    const after = setup({ id: 't4', status: 'active', properties: { checkpoint: 'after' } })
    after.ledger.recordSpawn('s5', null, 'bp-eml', 'claude', false, 't4')
    await after.r.turnEnded('s5', '### Handoff\nResult: draft written')
    expect(after.brain.posts[0].body.waiting_on).toMatchObject({ why: 'Review: draft written' })
  })

  it('changes nothing without a handoff or status, for a closed task, or where the task system is off', async () => {
    const plain = setup({ id: 't5', status: 'active', properties: {} })
    plain.ledger.recordSpawn('s6', null, 'bp-eml', 'claude', false, 't5')
    await plain.r.turnEnded('s6', 'Just chatting.')
    expect(plain.brain.posts).toHaveLength(0)

    const closed = setup({ id: 't6', status: 'resolved', properties: {} })
    closed.ledger.recordSpawn('s7', null, 'bp-eml', 'claude', false, 't6')
    await closed.r.turnEnded('s7', HANDOFF)
    expect(closed.brain.posts).toHaveLength(0)

    const shared = setup({ id: 't7', status: 'active', properties: {} }, { taskSystem: true, shared: true })
    shared.ledger.recordSpawn('s8', null, 'bp-eml', 'claude', false, 't7')
    await shared.r.turnEnded('s8', HANDOFF)
    expect(shared.brain.posts).toHaveLength(0)
  })

  it('logs instead of throwing when the brain fails', async () => {
    const { ledger, brain, r, logs } = setup({ id: 't8', status: 'active', properties: {} })
    brain.get = async () => { throw new Error('brain down') }
    ledger.recordSpawn('s9', null, 'bp-eml', 'claude', false, 't8')
    await expect(r.turnEnded('s9', HANDOFF)).resolves.toBeUndefined()
    expect(logs.at(-1)).toContain('brain down')
  })

  it('reads the last reply from a Stop hook: its field, else the transcript', () => {
    expect(router.replyFromStopHook({ last_assistant_message: 'hello' })).toBe('hello')
    const file = join(home, 'transcript.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: HANDOFF }, { type: 'tool_use' }] } }),
      JSON.stringify({ type: 'user', message: { content: 'tool result' } }),
    ].join('\n'))
    expect(router.replyFromStopHook({ transcript_path: file })).toBe(HANDOFF)
    expect(router.replyFromStopHook({ transcript_path: join(home, 'missing.jsonl') })).toBe('')
    expect(router.replyFromStopHook({})).toBe('')
  })
})
