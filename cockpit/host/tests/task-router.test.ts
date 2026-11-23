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

  const setup = (task: Record<string, unknown>, space: { shared: boolean } = { shared: false }) => {
    const ledger = new SessionLedger()
    const brain = fakeBrain(task)
    const logs: string[] = []
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => space as never }, brain: () => brain, owner: 'lasse',
      log: (l) => logs.push(l), now: () => new Date('2026-11-17T09:00:00Z'),
    })
    return { ledger, brain, r, logs }
  }

  it('puts the task on the user for a [lasse] question and writes the handoff once; the session itself is not marked as waiting', async () => {
    const { ledger, brain, r } = setup({ id: 't1', status: 'active', properties: {} })
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', false, 't1')
    await r.turnEnded('s1', HANDOFF)
    await r.turnEnded('s1', HANDOFF)
    expect(brain.posts).toHaveLength(1)
    expect(brain.posts[0].path).toBe('/task/t1/track')
    expect(brain.posts[0].body.text).toContain('Result: Homepage v4b hero')
    expect(brain.posts[0].body.waiting_on).toEqual({ who: 'lasse', kind: 'question', why: 'Ship the shorter headline?', since: '2026-11-17T09:00:00.000Z', session_id: 's1' })
    expect(ledger.get('s1')!.attention).toBeFalsy()
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
    expect(failed.brain.posts[0].body).toEqual({ waiting_on: expect.objectContaining({ kind: 'stopped', why: 'Build broke' }) })

    const after = setup({ id: 't4', status: 'active', properties: { checkpoint: 'after' } })
    after.ledger.recordSpawn('s5', null, 'bp-eml', 'claude', false, 't4')
    await after.r.turnEnded('s5', '### Handoff\nResult: draft written')
    expect(after.brain.posts[0].body.waiting_on).toMatchObject({ kind: 'review', why: 'Review: draft written' })
  })

  it('a question from a step with checkpoint before is a go', async () => {
    const { ledger, brain, r } = setup({ id: 't-go', status: 'active', properties: { checkpoint: 'before' } })
    ledger.recordSpawn('s-go', null, 'bp-eml', 'claude', false, 't-go')
    await r.turnEnded('s-go', HANDOFF)
    expect(brain.posts[0].body.waiting_on).toMatchObject({ kind: 'go', why: 'Ship the shorter headline?' })
  })

  it('puts a task on review when its session said review, whatever the checkpoint', async () => {
    const { ledger, brain, r } = setup({ id: 't-rv', status: 'active', properties: {} })
    ledger.recordSpawn('s-rv', null, 'bp-eml', 'claude', true, 't-rv')
    ledger.setAttention('s-rv', { kind: 'review', reason: 'Kim withdrew the cancellation' })
    await r.turnEnded('s-rv', '### Handoff\nResult: Kim withdrew the cancellation')
    expect(brain.posts[0].body.waiting_on).toMatchObject({ who: 'lasse', kind: 'review', why: 'Review: Kim withdrew the cancellation' })
  })

  it('leaves a quiet reschedule off the user: the handoff goes to the journal, nobody waits', async () => {
    const { ledger, brain, r } = setup({ id: 't-q', status: 'active', properties: {} })
    ledger.recordSpawn('s-q', null, 'bp-eml', 'claude', true, 't-q')
    ledger.setAttention('s-q', { kind: 'done', reason: 'No reply yet; next check tomorrow 10:00' })
    await r.turnEnded('s-q', '### Handoff\nResult: No reply from Kim yet.\nNext: check again tomorrow 10:00 (job)')
    expect(brain.posts[0].body).toEqual({ text: '### Handoff\nResult: No reply from Kim yet.\nNext: check again tomorrow 10:00 (job)' })
  })

  it('finishes a session that closed its task and asks nothing, and keeps one that still asks', async () => {
    const finished: string[] = []
    const ledger = new SessionLedger()
    const brain = fakeBrain({ id: 't9', status: 'resolved', properties: {} })
    const r = router.createTaskRouter({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, brain: () => brain, owner: 'lasse',
      finished: (id) => finished.push(id), log: () => {},
    })
    ledger.recordSpawn('s10', null, 'bp-eml', 'claude', true, 't9')
    ledger.recordSpawn('s11', null, 'bp-eml', 'claude', true, 't9')
    await r.turnEnded('s10', '### Handoff\nResult: step done')
    await r.turnEnded('s11', HANDOFF)
    expect(finished).toEqual(['s10'])
    expect(brain.posts).toHaveLength(0)
  })

  it('changes nothing without a handoff or status, or for a closed task, and routes in a shared space too', async () => {
    const plain = setup({ id: 't5', status: 'active', properties: {} })
    plain.ledger.recordSpawn('s6', null, 'bp-eml', 'claude', false, 't5')
    await plain.r.turnEnded('s6', 'Just chatting.')
    expect(plain.brain.posts).toHaveLength(0)

    const closed = setup({ id: 't6', status: 'resolved', properties: {} })
    closed.ledger.recordSpawn('s7', null, 'bp-eml', 'claude', false, 't6')
    await closed.r.turnEnded('s7', HANDOFF)
    expect(closed.brain.posts).toHaveLength(0)

    const shared = setup({ id: 't7', status: 'active', properties: {} }, { shared: true })
    shared.ledger.recordSpawn('s8', null, 'bp-eml', 'claude', false, 't7')
    await shared.r.turnEnded('s8', HANDOFF)
    expect(shared.brain.posts).toHaveLength(1)
  })

  it('keeps only the question, and clears a wait when the user answers the session that set it', async () => {
    expect(router.shortQuestion('Close the task despite the open mails?You wanted it done. The brightline task was')).toBe('Close the task despite the open mails?')
    const { ledger, brain, r } = setup({ id: 't20', status: 'active', properties: {} })
    ledger.recordSpawn('s20', null, 'bp-eml', 'claude', false, 't20')
    ledger.recordSpawn('s21', null, 'bp-eml', 'claude', false, 't20')
    await r.turnEnded('s20', HANDOFF)
    await r.answered('s21')
    expect(brain.posts.filter((p) => 'waiting_on' in p.body && p.body.waiting_on === null)).toHaveLength(0)
    await r.answered('s20')
    expect(brain.posts.at(-1)!.body).toEqual({ waiting_on: null })
  })

  it('clears the wait of a task that was closed', async () => {
    const { ledger, brain, r } = setup({ id: 't21', status: 'resolved', properties: { waiting_on: { who: 'lasse', why: 'x', since: 's', session_id: 'other' } } })
    ledger.recordSpawn('s22', null, 'bp-eml', 'claude', false, 't21')
    await r.turnEnded('s22', '### Handoff\nResult: done')
    expect(brain.posts).toEqual([{ path: '/task/t21/track', body: { waiting_on: null } }])
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
