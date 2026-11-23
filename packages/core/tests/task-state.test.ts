import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { plainJson, type OpEnvelope } from '@engramprotocol/protocol/log'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initDatabase, mostUrgentWait } from '../src'
import { uuidv5 } from '../src/log/op'
import { readObject } from '../src/objects'
import { createObject, updateObject, validNote, validTask, writes } from './fixtures'

// Schema 23 (task state): a task's delegation and waits, mirrored with the flat
// delegate/checkpoint and waiting_on on every write (src/task-state.ts), and the
// run object, which only the member it names writes (src/runs.ts).

describe('task.delegation mirrors delegate and checkpoint', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties as Record<string, any>
  const changes = (id: string) => eml.engrams.entries(id, ['change']).map(e => e.text)
  const task = (properties: Record<string, unknown> = {}) => writes(eml).store(validTask({ scope: 'project.eml', properties }))

  it('a task created with the flat fields gets a delegation: mode alone, not requested', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after' })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'after', mode: 'alone' })
  })

  it('a task created with a delegation gets the flat fields, timestamps as stored', () => {
    const t = task({ delegation: { mode: 'together', agent: 'atlas', checkpoint: 'before', requested_at: '2026-11-23' } })
    expect(props(t.id)).toMatchObject({
      delegate: 'atlas', checkpoint: 'before',
      delegation: { agent: 'atlas', checkpoint: 'before', mode: 'together', requested_at: '2026-11-23T00:00:00.000Z' },
    })
    // the stored keys are in one order, whatever order the caller sent
    expect(Object.keys(props(t.id).delegation)).toEqual(['agent', 'checkpoint', 'mode', 'requested_at'])
  })

  it('a checkpoint without a delegate has no delegation', () => {
    const t = task({ checkpoint: 'before' })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('before')
  })

  it('a flat write keeps mode, requested_at and next_run_at while the agent stays; a new agent starts a new delegation', () => {
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after', mode: 'together', requested_at: '2026-11-23T10:00:00.000Z', next_run_at: '2026-11-24T08:00:00.000Z' } })
    writes(eml).trackTask(t.id, { checkpoint: 'none' })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'none', mode: 'together', requested_at: '2026-11-23T10:00:00.000Z', next_run_at: '2026-11-24T08:00:00.000Z' })
    writes(eml).trackTask(t.id, { checkpoint: null })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', mode: 'together', requested_at: '2026-11-23T10:00:00.000Z', next_run_at: '2026-11-24T08:00:00.000Z' })
    writes(eml).trackTask(t.id, { delegate: 'motti', checkpoint: 'after' })
    expect(props(t.id).delegation).toEqual({ agent: 'motti', checkpoint: 'after', mode: 'alone' })
    expect(changes(t.id)).toEqual(expect.arrayContaining(['delegate atlas → motti', 'delegation request cleared', 'next run cleared']))
  })

  it('clearing the delegate clears the delegation; the checkpoint stays as written', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after' })
    writes(eml).trackTask(t.id, { delegate: null })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('after')
  })

  it('a delegation write sets the flat fields; null takes all three back', () => {
    const t = task({ checkpoint: 'none' })
    writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', mode: 'alone', requested_at: '2026-11-23T10:00:00.000Z' } })
    // the delegation carries no checkpoint, so the flat one is cleared to match
    expect(props(t.id)).toMatchObject({ delegate: 'atlas' })
    expect(props(t.id).checkpoint).toBeUndefined()
    writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', mode: 'together', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z' } })
    expect(changes(t.id)).toEqual(expect.arrayContaining(['delegate none → atlas', 'delegation requested', 'checkpoint none → after', 'mode alone → together']))
    writes(eml).trackTask(t.id, { delegation: null })
    const p = props(t.id)
    expect([p.delegate, p.checkpoint, p.delegation]).toEqual([undefined, undefined, undefined])
  })

  it('refuses both shapes in one call and a delegation that is not its shape', () => {
    const t = task()
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', mode: 'alone' }, checkpoint: 'after' })).toThrow('not both')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas' } })).toThrow('delegation needs mode.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: ' ', mode: 'alone' } })).toThrow('delegation.agent must not be blank.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', mode: 'alone', requested_at: 'soon' } })).toThrow('delegation.requested_at must be an ISO date')
    expect(() => writes(eml).trackTask(t.id, { delegation: 'atlas' })).toThrow('delegation must be an object')
    expect(() => writes(eml).store(validTask({ scope: 'project.eml', properties: { delegation: { agent: 'atlas', mode: 'alone' }, delegate: 'motti' } }))).toThrow('not both')
  })
})

describe('task.waits and waiting_on', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })
  afterEach(() => eml.close())

  const props = (id: string) => eml.engrams.getRaw(id)!.properties as Record<string, any>
  const changes = (id: string) => eml.engrams.entries(id, ['change']).map(e => e.text)
  const task = () => writes(eml).store(validTask({ scope: 'project.eml' }))

  it('waiting_on is the most urgent wait: by kind, then the oldest, without its id', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [
      { id: 'a', who: 'lasse', kind: 'go', why: 'start?', since: '2026-11-23T08:00:00.000Z', session_id: 'a' },
      { id: 'b', who: 'lasse', kind: 'review', why: 'look', since: '2026-11-23T10:00:00.000Z', session_id: 'b' },
      { id: 'c', who: 'dominik', kind: 'review', why: 'look too', since: '2026-11-23T09:00:00Z', session_id: 'c' },
    ] })
    expect(props(t.id).waiting_on).toEqual({ who: 'dominik', kind: 'review', why: 'look too', since: '2026-11-23T09:00:00.000Z', session_id: 'c' })
    expect(props(t.id).waits).toHaveLength(3)
    expect(changes(t.id)).toEqual(expect.arrayContaining(['waits → lasse · go, lasse · review, dominik · review', 'waiting on nobody → dominik · look too']))
  })

  it('a wait without a kind ranks after every kind; equal ones keep list order', () => {
    expect(mostUrgentWait([{ id: 'x', who: 'a' }, { id: 'y', who: 'b', kind: 'outside' }])?.id).toBe('y')
    expect(mostUrgentWait([{ id: 'x', who: 'a', kind: 'go' }, { id: 'y', who: 'b', kind: 'go' }])?.id).toBe('x')
    expect(mostUrgentWait([])).toBeUndefined()
  })

  it('an empty list or null clears both', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question' }] })
    writes(eml).trackTask(t.id, { waits: [] })
    expect([props(t.id).waits, props(t.id).waiting_on]).toEqual([undefined, undefined])
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question' }] })
    writes(eml).trackTask(t.id, { waits: null })
    expect([props(t.id).waits, props(t.id).waiting_on]).toEqual([undefined, undefined])
  })

  it('a flat waiting_on write (a cockpit that knows one wait) replaces waits with that wait', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question' }, { id: 'b', who: 'dominik', kind: 'go' }] })
    writes(eml).trackTask(t.id, { waiting_on: { who: 'lasse', kind: 'review', why: 'done', since: '2026-11-23T10:00:00.000Z', session_id: 's1' } })
    expect(props(t.id).waits).toEqual([{ id: 's1', who: 'lasse', kind: 'review', why: 'done', since: '2026-11-23T10:00:00.000Z', session_id: 's1' }])
    // values that do not fit a wait are left out of it; waiting_on keeps them as written
    writes(eml).trackTask(t.id, { waiting_on: { who: 'lasse', kind: 'someday', since: 'yesterday', note: 'x' } })
    expect(props(t.id).waits).toEqual([{ id: 'waiting_on', who: 'lasse' }])
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', kind: 'someday', since: 'yesterday', note: 'x' })
    // no who, no wait
    writes(eml).trackTask(t.id, { waiting_on: { why: 'nobody' } })
    expect(props(t.id).waits).toBeUndefined()
    writes(eml).trackTask(t.id, { waiting_on: null })
    expect([props(t.id).waits, props(t.id).waiting_on]).toEqual([undefined, undefined])
  })

  it('a task created with waiting_on gets its waits', () => {
    const t = writes(eml).store(validTask({ scope: 'project.eml', properties: { waiting_on: { who: 'lasse', kind: 'go', session_id: 's1' } } }))
    expect(props(t.id).waits).toEqual([{ id: 's1', who: 'lasse', kind: 'go', session_id: 's1' }])
  })

  it('refuses both shapes in one call, a repeated id, an unknown key and an entry without who', () => {
    const t = task()
    expect(() => writes(eml).trackTask(t.id, { waits: [], waiting_on: null })).toThrow('not both')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'x' }, { id: 'a', who: 'y' }] })).toThrow('waits: id a occurs twice.')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'x', owner: 'y' }] })).toThrow('waits[0] has unknown key owner')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a' }] })).toThrow('waits[0] needs who.')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'x', since: 3 }] })).toThrow('waits[0].since must be an ISO date')
  })
})

describe('the run object', () => {
  let eml: EML
  let taskId: string
  const juno = () => eml.env({ handle: 'juno', session_id: 's1', ingestion_method: 'direct' })
  const ada = () => eml.env({ handle: 'ada', session_id: 's2', ingestion_method: 'direct' })
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test', clock: () => '2026-11-23T12:00:00.000Z' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
    taskId = writes(eml).store(validTask({ scope: 'project.eml' })).id
  })
  afterEach(() => eml.close())

  const changes = () => eml.engrams.entries(taskId, ['change']).map(e => e.text)

  it('is created by its member, with defaults for state and started_at, and journaled on its task', () => {
    const { object } = createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', agent: 'atlas', origin: 'runner', driver: 'agent', lease_until: '2026-11-23T12:15:00Z' }, juno())
    expect(object).toEqual({
      id: 'sess-1', task_id: taskId, member: 'juno', agent: 'atlas', origin: 'runner', driver: 'agent', state: 'running',
      started_at: '2026-11-23T12:00:00.000Z', heartbeat_at: null, lease_until: '2026-11-23T12:15:00.000Z',
      created_at: '2026-11-23T12:00:00.000Z', updated_at: '2026-11-23T12:00:00.000Z',
    })
    expect(changes()).toContain('run sess-1 started (runner, agent, atlas)')
    expect(readObject(eml, 'run', { id: 'sess-1' })).toEqual(object)
  })

  it('only its member changes it; the fixed fields never change', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'idle' }, ada())).toThrow('only its member juno changes run sess-1.')
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'idle' })).toThrow('only its member juno changes run sess-1.')
    for (const k of ['task_id', 'member', 'origin', 'started_at', 'id']) {
      expect(() => updateObject(eml, 'run', 'sess-1', { [k]: k === 'started_at' ? '2026-11-23' : 'x' }, juno())).toThrow(`${k} cannot change.`)
    }
    const r = updateObject(eml, 'run', 'sess-1', { state: 'awaiting_input', heartbeat_at: '2026-11-23T12:05:00Z' }, juno())!
    expect(r.diff).toEqual({ state: ['running', 'awaiting_input'], heartbeat_at: [null, '2026-11-23T12:05:00.000Z'] })
  })

  it('a member starts runs only for themself, on a task of this brain, once per session', () => {
    const note = writes(eml).store(validNote({ scope: 'project.eml' })).id
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'ada', origin: 'user', driver: 'human' }, juno())).toThrow('member is the member who writes it (juno), not ada.')
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' })).toThrow('this write has no handle')
    expect(() => createObject(eml, 'run', { id: 's', task_id: note, member: 'juno', origin: 'user', driver: 'human' }, juno())).toThrow('is not a task of this brain')
    expect(() => createObject(eml, 'run', { id: 'a b', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())).toThrow('a run id is letters')
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'cron', driver: 'human' }, juno())).toThrow('origin must be one of user, runner, job.')
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', agent: 'Not A Handle' }, juno())).toThrow('agent is 1–63 characters')
    createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    expect(() => createObject(eml, 'run', { id: 's', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())).toThrow('already exists')
  })

  it('its end and a resume are journaled on the task; the states between are not', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'idle' }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'ended', lease_until: null }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'running' }, juno())
    expect(changes().filter(t => t.startsWith('run '))).toEqual(['run sess-1 started (user, human)', 'run sess-1 ended', 'run sess-1 resumed'])
  })

  it('lists the runs not ended by default, a state with the status filter', () => {
    createObject(eml, 'run', { id: 'a', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    createObject(eml, 'run', { id: 'b', task_id: taskId, member: 'ada', origin: 'job', driver: 'agent', state: 'ended' }, ada())
    expect((readObject(eml, 'run') as Array<{ id: string }>).map(r => r.id)).toEqual(['a'])
    expect((readObject(eml, 'run', { status: 'ended' }) as Array<{ id: string }>).map(r => r.id)).toEqual(['b'])
    expect(() => readObject(eml, 'run', { status: 'gone' })).toThrow('status for run is one of running, idle, awaiting_input, ended.')
    expect(eml.runs.list({ task_id: 'other' })).toEqual([])
  })
})

describe('the run member rule in a shared brain', () => {
  const BRAIN = '7c9e6679-7425-40de-944b-e07fc1f90ae7'
  const DEVICE = 'a3sZzh-3scuWtpRhBZ11JKFldGAAN8sXviHJMKrc6U4'
  const T0 = Date.parse('2026-11-23T08:00:00.000Z')
  const NONE = { handle: null, agent: null, ingestion_method: null, session_id: null, model: null, harness: null }
  const as = (handle: string) => ({ ...NONE, handle, ingestion_method: 'mcp' })

  function op(n: number, call: string, args: unknown, provenance: Record<string, unknown>): OpEnvelope {
    return {
      op_id: uuidv5(BRAIN, `op ${n}`), schema: CURRENT_BRAIN_SCHEMA_VERSION, call, args: args as never, provenance: provenance as never,
      team: { brain: BRAIN, device: DEVICE, base_seq: n - 1, head_hash: '0'.repeat(64) },
    }
  }
  const take = (eml: EML, seq: number, o: OpEnvelope) =>
    eml.takeRelayed({ seq, at: new Date(T0 + seq * 1000).toISOString(), op_id: o.op_id, payload: plainJson(o), signature: null, rejected: null }, o).rejected

  it('every replica refuses one member\'s op on another member\'s run and keeps it as rejected', () => {
    const eml = EML.fromConnection(initDatabase(':memory:', undefined, BRAIN, { log: false }), 'test')
    expect(take(eml, 1, op(1, 'brain.genesis', { state_hash: eml.stateHash() }, NONE))).toBeNull()
    expect(take(eml, 2, op(2, 'object.create', { object: 'project', fields: { id: 'eml', name: 'EML' } }, as('lasse')))).toBeNull()
    expect(take(eml, 3, op(3, 'engram.create', validTask({ scope: 'project.eml', title: 'shared-task' }), as('lasse')))).toBeNull()
    const taskId = (eml as any).db.prepare(`SELECT id FROM engrams WHERE title = 'shared-task'`).get().id as string
    expect(take(eml, 4, op(4, 'object.create', { object: 'run', fields: { id: 'sess-l', task_id: taskId, member: 'lasse', origin: 'user', driver: 'human' } }, as('lasse')))).toBeNull()
    expect(take(eml, 5, op(5, 'object.update', { object: 'run', id: 'sess-l', patch: { state: 'ended' } }, as('dominik'))))
      .toBe('INVALID: Invalid object: only its member lasse changes run sess-l.')
    expect(take(eml, 6, op(6, 'object.create', { object: 'run', fields: { id: 'sess-d', task_id: taskId, member: 'lasse', origin: 'user', driver: 'human' } }, as('dominik'))))
      .toBe('INVALID: Invalid object: a run\'s member is the member who writes it (dominik), not lasse.')
    expect(eml.runs.get('sess-l')!.state).toBe('running')
    expect(eml.runs.get('sess-d')).toBeNull()
    expect(take(eml, 7, op(7, 'object.update', { object: 'run', id: 'sess-l', patch: { state: 'ended' } }, as('lasse')))).toBeNull()
    expect(eml.runs.get('sess-l')!.state).toBe('ended')
    eml.close()
  })
})
