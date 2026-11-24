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

  it('a task created with the flat fields gets a delegation, requested at its creation when it has a checkpoint', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after' })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'after', requested_at: props(t.id).delegation.requested_at })
    expect(props(t.id).delegation.requested_at).toBe(eml.engrams.getRaw(t.id)!.created_at)
  })

  it('a task created with a delegate but no checkpoint, or with a schedule, is not requested', () => {
    expect(props(task({ delegate: 'atlas' }).id).delegation).toEqual({ agent: 'atlas' })
    const scheduled = task({ delegation: { agent: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-28T10:00:00Z' } } })
    expect(props(scheduled.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'after', schedule: { at: '2026-11-28T10:00:00.000Z' } })
  })

  it('a task created with a delegation gets the flat fields, timestamps as stored', () => {
    const t = task({ delegation: { schedule: { session: 'new', time_zone: 'Asia/Makassar', cron: '0 8 * * 1-5' }, agent: 'atlas', checkpoint: 'before', requested_at: '2026-11-23' } })
    expect(props(t.id)).toMatchObject({
      delegate: 'atlas', checkpoint: 'before',
      delegation: { agent: 'atlas', checkpoint: 'before', requested_at: '2026-11-23T00:00:00.000Z', schedule: { cron: '0 8 * * 1-5', time_zone: 'Asia/Makassar', session: 'new' } },
    })
    // the stored keys are in one order, whatever order the caller sent
    expect(Object.keys(props(t.id).delegation)).toEqual(['agent', 'checkpoint', 'requested_at', 'schedule'])
    expect(Object.keys(props(t.id).delegation.schedule)).toEqual(['cron', 'time_zone', 'session'])
  })

  it('a checkpoint without a delegate has no delegation', () => {
    const t = task({ checkpoint: 'before' })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('before')
  })

  it('a flat write keeps requested_at and the schedule while the agent stays; a new agent starts a new delegation', () => {
    const schedule = { at: '2026-11-24T08:00:00.000Z', session: 'resume' }
    const t = task({ delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z', schedule } })
    writes(eml).trackTask(t.id, { checkpoint: 'none' })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', checkpoint: 'none', requested_at: '2026-11-23T10:00:00.000Z', schedule })
    writes(eml).trackTask(t.id, { checkpoint: null })
    expect(props(t.id).delegation).toEqual({ agent: 'atlas', requested_at: '2026-11-23T10:00:00.000Z', schedule })
    writes(eml).trackTask(t.id, { delegate: 'motti', checkpoint: 'after' })
    expect(props(t.id).delegation).toEqual({ agent: 'motti', checkpoint: 'after' })
    expect(changes(t.id)).toEqual(expect.arrayContaining(['delegate atlas → motti', 'delegation request cleared', 'schedule at 2026-11-24T08:00:00.000Z (resume) → none']))
  })

  it('clearing the delegate clears the delegation; the checkpoint stays as written', () => {
    const t = task({ delegate: 'atlas', checkpoint: 'after' })
    writes(eml).trackTask(t.id, { delegate: null })
    expect(props(t.id).delegation).toBeUndefined()
    expect(props(t.id).checkpoint).toBe('after')
  })

  it('a delegation write sets the flat fields; null takes all three back', () => {
    const t = task({ checkpoint: 'none' })
    writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', requested_at: '2026-11-23T10:00:00.000Z' } })
    // the delegation carries no checkpoint, so the flat one is cleared to match
    expect(props(t.id)).toMatchObject({ delegate: 'atlas' })
    expect(props(t.id).checkpoint).toBeUndefined()
    writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', checkpoint: 'after', requested_at: '2026-11-23T10:00:00.000Z', schedule: { cron: '0 9 * * 1', paused: true } } })
    expect(changes(t.id)).toEqual(expect.arrayContaining(['delegate none → atlas', 'delegation requested', 'checkpoint none → after', 'schedule none → cron 0 9 * * 1 (paused)']))
    writes(eml).trackTask(t.id, { delegation: null })
    const p = props(t.id)
    expect([p.delegate, p.checkpoint, p.delegation]).toEqual([undefined, undefined, undefined])
  })

  it('refuses both shapes in one call and a delegation that is not its shape', () => {
    const t = task()
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas' }, checkpoint: 'after' })).toThrow('not both')
    expect(() => writes(eml).trackTask(t.id, { delegation: { checkpoint: 'after' } })).toThrow('delegation needs agent.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', mode: 'alone' } })).toThrow('delegation has unknown key mode')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: ' ' } })).toThrow('delegation.agent must not be blank.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', requested_at: 'soon' } })).toThrow('delegation.requested_at must be an ISO date')
    expect(() => writes(eml).trackTask(t.id, { delegation: 'atlas' })).toThrow('delegation must be an object')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', schedule: { session: 'new' } } })).toThrow('exactly one of at')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', schedule: { at: '2026-11-28', cron: '0 8 * * *' } } })).toThrow('exactly one of at')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', schedule: { cron: '0 8 * * *', session: 'later' } } })).toThrow('delegation.schedule.session must be one of new, resume.')
    expect(() => writes(eml).trackTask(t.id, { delegation: { agent: 'atlas', schedule: { cron: '0 8 * * *', paused: 'yes' } } })).toThrow('delegation.schedule.paused must be true or false.')
    expect(() => writes(eml).store(validTask({ scope: 'project.eml', properties: { delegation: { agent: 'atlas' }, delegate: 'motti' } }))).toThrow('not both')
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

  it('waiting_on is the most urgent wait: a question above a review, then the oldest, without its id', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [
      { id: 'a', who: 'lasse', kind: 'review', why: 'look', since: '2026-11-23T08:00:00.000Z', session_id: 'a' },
      { id: 'b', who: 'lasse', kind: 'question', why: 'which?', since: '2026-11-23T10:00:00.000Z', session_id: 'b' },
      { id: 'c', who: 'dominik', kind: 'question', why: 'which too?', since: '2026-11-23T09:00:00Z', session_id: 'c' },
    ] })
    expect(props(t.id).waiting_on).toEqual({ who: 'dominik', kind: 'question', why: 'which too?', since: '2026-11-23T09:00:00.000Z', session_id: 'c' })
    expect(props(t.id).waits).toHaveLength(3)
    expect(changes(t.id)).toEqual(expect.arrayContaining(['waits → lasse · review, lasse · question, dominik · question', 'waiting on nobody → dominik · which too?']))
  })

  it('a parked wait ranks after every wait that is not, and waiting_on leaves its snooze out', () => {
    const t = task()
    writes(eml).trackTask(t.id, { waits: [
      { id: 'a', who: 'lasse', kind: 'question', snoozed_until: '2026-11-30' },
      { id: 'b', who: 'lasse', kind: 'outside', why: 'vendor' },
    ] })
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', kind: 'outside', why: 'vendor' })
    expect(props(t.id).waits[0].snoozed_until).toBe('2026-11-30T00:00:00.000Z')
    writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', kind: 'question', snoozed_until: 'open' }] })
    expect(props(t.id).waiting_on).toEqual({ who: 'lasse', kind: 'question' })
    expect(props(t.id).waits[0].snoozed_until).toBe('open')
    expect(() => writes(eml).trackTask(t.id, { waits: [{ id: 'a', who: 'lasse', snoozed_until: 'someday' }] })).toThrow('snoozed_until is an ISO date or "open"')
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

  it('is created by its member, with defaults for state, started_at and last_activity_at, and journaled on its task', () => {
    const { object } = createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', agent: 'atlas', origin: 'runner', driver: 'agent' }, juno())
    expect(object).toEqual({
      id: 'sess-1', task_id: taskId, member: 'juno', agent: 'atlas', origin: 'runner', driver: 'agent', state: 'running',
      started_at: '2026-11-23T12:00:00.000Z', last_activity_at: '2026-11-23T12:00:00.000Z', ended_at: null, end_reason: null, result: null,
      created_at: '2026-11-23T12:00:00.000Z', updated_at: '2026-11-23T12:00:00.000Z',
    })
    expect(changes()).toContain('run sess-1 started (runner, agent, atlas)')
    expect(readObject(eml, 'run', { id: 'sess-1' })).toEqual(object)
  })

  it('only its member changes it; the fixed fields never change; every write is its last activity', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', started_at: '2026-11-23T11:00:00Z' }, juno())
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'idle' }, ada())).toThrow('only its member juno changes run sess-1.')
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'idle' })).toThrow('only its member juno changes run sess-1.')
    for (const k of ['task_id', 'member', 'origin', 'started_at', 'id']) {
      expect(() => updateObject(eml, 'run', 'sess-1', { [k]: k === 'started_at' ? '2026-11-23' : 'x' }, juno())).toThrow(`${k} cannot change.`)
    }
    const r = updateObject(eml, 'run', 'sess-1', { state: 'idle', result: 'Draft ready.' }, juno())!
    expect(r.diff).toEqual({ state: ['running', 'idle'], result: [null, 'Draft ready.'], last_activity_at: ['2026-11-23T11:00:00.000Z', '2026-11-23T12:00:00.000Z'] })
  })

  it('ending sets ended_at and its reason; a resume clears both; end fields only on an ended run', () => {
    createObject(eml, 'run', { id: 'sess-1', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    expect(() => updateObject(eml, 'run', 'sess-1', { end_reason: 'finished' }, juno())).toThrow('end_reason is for an ended run.')
    expect(() => updateObject(eml, 'run', 'sess-1', { state: 'ended', end_reason: 'bored' }, juno())).toThrow('end_reason must be one of finished, put_away, failed, crashed.')
    expect(() => updateObject(eml, 'run', 'sess-1', { last_activity_at: null }, juno())).toThrow('last_activity_at cannot be cleared.')
    updateObject(eml, 'run', 'sess-1', { state: 'ended', end_reason: 'put_away' }, juno())
    expect(eml.runs.get('sess-1')).toMatchObject({ state: 'ended', end_reason: 'put_away', ended_at: '2026-11-23T12:00:00.000Z' })
    updateObject(eml, 'run', 'sess-1', { state: 'running' }, juno())
    expect(eml.runs.get('sess-1')).toMatchObject({ state: 'running', end_reason: null, ended_at: null })
    const crashed = createObject(eml, 'run', { id: 'sess-2', task_id: taskId, member: 'juno', origin: 'runner', driver: 'agent', state: 'ended', end_reason: 'crashed' }, juno()).object
    expect(crashed).toMatchObject({ state: 'ended', end_reason: 'crashed', ended_at: '2026-11-23T12:00:00.000Z' })
    expect(() => createObject(eml, 'run', { id: 'sess-3', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', state: 'awaiting_input' }, juno())).toThrow('state must be one of running, idle, ended.')
    expect(() => createObject(eml, 'run', { id: 'sess-3', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', heartbeat_at: '2026-11-23' }, juno())).toThrow('heartbeat_at')
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
    updateObject(eml, 'run', 'sess-1', { state: 'ended', end_reason: 'finished' }, juno())
    updateObject(eml, 'run', 'sess-1', { state: 'running' }, juno())
    expect(changes().filter(t => t.startsWith('run '))).toEqual(['run sess-1 started (user, human)', 'run sess-1 ended (finished)', 'run sess-1 resumed'])
  })

  it('lists the runs not ended by default, a state with the status filter', () => {
    createObject(eml, 'run', { id: 'a', task_id: taskId, member: 'juno', origin: 'user', driver: 'human' }, juno())
    createObject(eml, 'run', { id: 'b', task_id: taskId, member: 'ada', origin: 'job', driver: 'agent', state: 'ended' }, ada())
    expect((readObject(eml, 'run') as Array<{ id: string }>).map(r => r.id)).toEqual(['a'])
    expect((readObject(eml, 'run', { status: 'ended' }) as Array<{ id: string }>).map(r => r.id)).toEqual(['b'])
    expect(() => readObject(eml, 'run', { status: 'gone' })).toThrow('status for run is one of running, idle, ended.')
    expect(eml.runs.list({ task_id: 'other' })).toEqual([])
    // the newest run of each task, whatever its state
    createObject(eml, 'run', { id: 'c', task_id: taskId, member: 'juno', origin: 'user', driver: 'human', started_at: '2026-11-23T13:00:00Z', state: 'ended' }, juno())
    expect((readObject(eml, 'run', { latest: true }) as Array<{ id: string }>).map(r => r.id)).toEqual(['c'])
    // a number: the newest n runs of each task, newest first per task
    expect((readObject(eml, 'run', { latest: 2 }) as Array<{ id: string }>).map(r => r.id)).toEqual(['c', 'b'])
    expect(() => readObject(eml, 'run', { latest: 51 })).toThrow('whole number from 1 to 50')
    expect(() => readObject(eml, 'project', { latest: true })).toThrow('for runs only')
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
