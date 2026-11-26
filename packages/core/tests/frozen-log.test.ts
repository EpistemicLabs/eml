import { describe, it, expect } from 'vitest'
import { existsSync, writeFileSync } from 'fs'
import Database from 'better-sqlite3'
import { canonicalJson } from '@engramprotocol/protocol/log'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { COMMAND_NAMES } from '../src/commands'
import { frozenLogFile, readFrozenLog, type FrozenLog } from '../src/contract/frozen'
import { verify } from '../src/log/rebuild'
import { FROZEN_BRAIN, refusalOf, replayFrozenLog, selfTest } from '../src/log/self-test'
import { stateDump, stateHash } from '../src/log/snapshot'
import { validDecision, validNote, validRule, validTask, writes, writeEverything } from './fixtures'

// The frozen log of the current brain schema (contracts/log-v<N>.json): a log
// that calls every command, the hash of the state it replays to, and writes
// the brain refuses on that state with what it answers. What a logged op does
// is part of the log format — validation, enums, limits, scope patterns, the
// learning topic gate, defaults, change-entry texts, slugs, wikilinks. Every
// replica and every later rebuild must derive the same state from the same
// log, on every platform, so this test replays the file as it was written
// and compares. The file ships with every build, which replays it when it
// starts (log/self-test.ts); the loader here is that one.
//
// When it fails, the change under test makes an existing log replay to another
// state. That is a new brain schema (CLAUDE.md), not a new fixture. The file
// is written again only with a schema bump or to cover a new command:
// `EML_FREEZE_LOG=1 pnpm -F @engramprotocol/core test frozen-log`, and the
// diff is reviewed like code. The contract document names the log's state
// hash, so it is generated again after a freeze (tests/contract.test.ts).

const SCHEMA = CURRENT_BRAIN_SCHEMA_VERSION
const FILE = frozenLogFile()
const START = Date.parse('2026-11-19T08:00:00.000Z')

type Frozen = FrozenLog

const raw = (eml: EML): Database.Database => (eml as any).db

/** The brain the file is written from: writeEverything, learnings on neighbouring topics, an update at a revision. */
function write(): Frozen {
  let t = START
  let n = 0
  const eml = new EML({
    dbPath: ':memory:', namespace: 'frozen', brainId: FROZEN_BRAIN,
    clock: () => new Date(t++).toISOString(),
    newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
  })
  writeEverything(eml)
  const juno = eml.env({ handle: 'juno', session_id: 's1', model: 'm', harness: 'h', ingestion_method: 'mcp' })
  const decision = writes(eml).store(validDecision({ scope: 'project.q', title: 'rev-checked' }), juno)
  eml.apply({ name: 'engram.update', input: { id: decision.id, patch: { content: 'at rev 1' }, base_rev: 1 } }, juno)
  // learnings whose terms overlap: the topic gate ranks them, and near-ties must rank alike everywhere
  for (const [title, content] of [
    ['check-deploy-logs', 'Check the deploy logs after every rollout.'],
    ['write-release-notes', 'Write the release notes, then check them twice.'],
    ['keep-deploy-notes', 'Keep deploy notes next to the release logs.'],
    ['read-server-output', 'Read the server output first when a request fails.'],
  ]) {
    const learned = writes(eml).learn({ scope: 'agent.juno', title, content, source: 'observed', happened: 'seen once' }, juno)
    if (!learned.written) throw new Error(`${title} was taken as an existing topic`)
  }

  const task = writes(eml).store(validTask({ scope: 'project.q', title: 'tracked' }), juno)

  const actor = juno.actor
  const tries: Array<[string, unknown]> = [
    ['engram.create', validRule({ scope: 'agent.juno', title: 'too-long', content: 'x'.repeat(201) })],
    ['engram.create', { ...validDecision({ scope: 'project.q', title: 'no-alternative' }), properties: { rationale: 'because' } }],
    ['engram.create', validNote({ scope: 'project.nowhere', title: 'no-such-project' })],
    ['engram.create', validNote({ scope: 'Project Q', title: 'no-such-scope' })],
    ['engram.create', validNote({ scope: 'project.q', title: 'no-such-tag', tags: ['unregistered'] })],
    ['engram.create', { type: 'memo', scope: 'project.q', title: 'no-such-type', content: 'a memo' }],
    ['engram.create', validTask({ scope: 'project.q', title: 'born-closed', status: 'resolved' })],
    ['engram.create', { type: 'learning', scope: 'agent.juno', title: 'check-deploy-release', content: 'Check deploy logs and release notes.', evidence: { source: 'observed', happened: 'seen again' } }],
    ['engram.update', { id: decision.id, patch: { content: 'stale' }, base_rev: 1 }],
    ['engram.update', { id: decision.id, patch: { status: 'pending' } }],
    ['task.track', { id: decision.id, text: 'not a task' }],
    ['relation.create', { source_id: decision.id, target_id: decision.id, relation: 'likes', detection_method: 'manual' }],
    ['object.create', { object: 'project', fields: { id: 'Not A Slug', name: 'X' } }],
    ['object.update', { object: 'tag', id: 'unregistered', patch: { description: 'none' } }],
    ['engram.retag', { ids: [decision.id], add: ['unregistered'], remove: [] }],
    ['engram.rescope', { ids: [decision.id], scope: 'project.nowhere' }],
    // a key the call does not take is refused, never ignored (schema 22): top level, envelope, nested, a null value, an inherited name
    ['task.track', { id: task.id, text: 'progress', done_when: 'it ships' }],
    ['engram.update', { id: decision.id, patch: { content: 'changed' }, note: 'x' }],
    ['engram.update', { id: decision.id, patch: { properties: { toString: 'x' } } }],
    ['engram.create', { ...validNote({ scope: 'project.q', title: 'null-field' }), properties: { verdict: null } }],
    ['engram.create', { ...validNote({ scope: 'project.q', title: 'inherited-name' }), properties: { constructor: 'x' } }],
    ['engram.create', { type: 'learning', scope: 'agent.juno', title: 'lesson-in-evidence', content: 'Keep the lesson out of the evidence.', new_topic: true, evidence: { source: 'observed', happened: 'once', title: 'another-title' } }],
    ['engram.confirm_review', { id: decision.id, text: 'still holds', note: 'x' }],
    ['object.create', { object: 'tag', fields: { name: 'extra' }, note: 'x' }],
    ['object.create', { object: 'tag', fields: { name: 'extra', valueOf: 'x' } }],
    ['object.update', { object: 'project', id: 'q', patch: { goal: 'none' }, note: 'x' }],
    ['engram.import', { source: { brain: 'b', head_seq: 1, note: 'x' }, set_hash: '', rows: {} }],
    ['engram.move_out', { ids: [decision.id], set_hash: '0'.repeat(64), drop_relations: [], target: { brain: 'b', op_id: 'o', note: 'x' } }],
    // schema 23: the shapes of delegation and waits, one shape per call, and who writes a run
    ['task.track', { id: task.id, delegation: { agent: 'juno' }, delegate: 'juno' }],
    ['task.track', { id: task.id, waits: [], waiting_on: { who: 'ada' } }],
    ['task.track', { id: task.id, delegation: { checkpoint: 'after' } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', checkpoint: null } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', mode: 'alone' } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', owner: 'ada' } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: ['0 8 * * *'], paused: 'yes' } } }],
    // schema 24: a schedule is repeating times and one wake-up; the keys of schema 23 are unknown
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { time_zone: 'Europe/Berlin' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { why: 'look again', by_session: 's1' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { cron: '0 8 * * *' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: ['0 8 * * *'], session: 'new' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: '0 8 * * *' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: [] } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: [], at: '2026-11-20' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: ['0 8 * * *', ' '] } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: ['0 8 * * *', ' 0 8 * * * '] } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { crons: Array.from({ length: 11 }, (_, i) => `${i} 8 * * *`) } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { at: '2026-11-20', why: 'x'.repeat(2001) } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { at: 'tomorrow' } } }],
    ['task.track', { id: task.id, delegation: { agent: 'juno', schedule: { at: '2026-11-20', ends_at: 'never' } } }],
    ['task.track', { id: task.id, waits: [{ id: 'w', who: 'ada', snoozed_until: 'someday' }] }],
    ['task.track', { id: task.id, waits: [{ id: 'w', who: 'ada' }, { id: 'w', who: 'juno' }] }],
    ['task.track', { id: task.id, waits: [{ id: 'w', who: 'ada', kind: 'someday' }] }],
    ['task.track', { id: task.id, waits: { id: 'w', who: 'ada' } }],
    ['object.create', { object: 'run', fields: { id: 'for-ada', task_id: task.id, member: 'ada', origin: 'user', driver: 'human' } }],
    ['object.create', { object: 'run', fields: { id: 'on-a-decision', task_id: decision.id, member: 'juno', origin: 'user', driver: 'human' } }],
    ['object.create', { object: 'run', fields: { id: 'session-1', task_id: task.id, member: 'juno', origin: 'user', driver: 'human' } }],
    ['object.create', { object: 'run', fields: { id: 'no-origin', task_id: task.id, member: 'juno', driver: 'human' } }],
    ['object.update', { object: 'run', id: 'session-2', patch: { state: 'ended' } }],
    ['object.update', { object: 'run', id: 'session-1', patch: { task_id: task.id } }],
    ['object.update', { object: 'run', id: 'session-1', patch: { state: null } }],
    ['object.create', { object: 'run', fields: { id: 'early-end', task_id: task.id, member: 'juno', origin: 'user', driver: 'human', end_reason: 'finished' } }],
    ['object.create', { object: 'run', fields: { id: 'old-state', task_id: task.id, member: 'juno', origin: 'user', driver: 'human', state: 'awaiting_input' } }],
    ['object.create', { object: 'run', fields: { id: 'with-lease', task_id: task.id, member: 'juno', origin: 'user', driver: 'human', heartbeat_at: '2026-11-19T09:00:00Z' } }],
    ['object.create', { object: 'run', fields: { id: 'bad-reason', task_id: task.id, member: 'juno', origin: 'user', driver: 'human', state: 'ended', end_reason: 'bored' } }],
  ]
  const refused = tries.map(([name, input]) => ({ name, input, actor, error: refusalOf(eml, name, input, actor) }))

  const db = raw(eml)
  const genesis = db.prepare('SELECT state_hash, data FROM op_snapshots WHERE seq = 1').get() as { state_hash: string, data: Buffer }
  const frozen: Frozen = {
    schema: SCHEMA,
    state_hash: eml.stateHash(),
    genesis: { state_hash: genesis.state_hash, data: genesis.data.toString('base64') },
    entries: db.prepare('SELECT seq, at, op_id, prev_hash, payload_hash, hash, payload FROM op_log ORDER BY seq').all() as Frozen['entries'],
    refused,
  }
  eml.close()
  return frozen
}

if (process.env.EML_FREEZE_LOG === '1') {
  writeFileSync(FILE, JSON.stringify(write(), null, 1) + '\n')
}

describe(`the frozen log of brain schema ${SCHEMA}`, () => {
  it('exists for the schema this code replays', () => {
    // a schema bump freezes its own log: EML_FREEZE_LOG=1 once the new schema's commands are final
    expect(existsSync(FILE), `no frozen log for schema ${SCHEMA} (${FILE})`).toBe(true)
  })
  if (!existsSync(FILE)) return
  const frozen = readFrozenLog()

  it('calls every command', () => {
    const called = new Set(frozen.entries.map(e => (JSON.parse(e.payload) as { call: string }).call))
    expect(COMMAND_NAMES.filter(name => !called.has(name))).toEqual([])
  })

  it('replays to the state hash it was frozen with, and verifies', () => {
    const brain = replayFrozenLog(frozen)
    expect(stateHash(stateDump(brain))).toBe(frozen.state_hash)
    expect(verify(brain)).toEqual({ ok: true, entries: frozen.entries.length, state_hash: frozen.state_hash })
    brain.close()
  })

  it('refuses the same writes with the same answers', () => {
    const brain = replayFrozenLog(frozen)
    const eml = EML.fromConnection(brain, 'frozen')
    for (const { name, input, actor, error } of frozen.refused) {
      expect(canonicalJson(refusalOf(eml, name, input, actor) as never), `${name} ${JSON.stringify(input).slice(0, 80)}`).toBe(canonicalJson(error as never))
    }
    expect(stateHash(stateDump(brain))).toBe(frozen.state_hash)
    brain.close()
  })

  it('passes the self-test a build runs when it starts', () => {
    expect(selfTest()).toEqual({ ok: true, schema: SCHEMA, entries: frozen.entries.length, state_hash: frozen.state_hash })
  })

  it('fails the self-test of a build that replays it to another state or answers a refused write differently', () => {
    // another build is stood in for by another file: the log as frozen, with what a build of other rules would have frozen
    expect(selfTest({ ...frozen, state_hash: '0'.repeat(64) })).toMatchObject({ ok: false, problem: expect.stringContaining('replays to state') })
    const [first, ...rest] = frozen.refused
    expect(selfTest({ ...frozen, refused: [{ ...first, error: { ...first.error, message: 'another answer' } }, ...rest] }))
      .toMatchObject({ ok: false, problem: expect.stringContaining('answered differently') })
    // a write this build takes, frozen as refused by a build that knows one key less
    const taken = { name: 'object.create', input: { object: 'tag', fields: { name: 'fresh-tag' } }, actor: first.actor, error: first.error }
    expect(selfTest({ ...frozen, refused: [taken] })).toMatchObject({ ok: false, problem: expect.stringContaining('was taken') })
    expect(selfTest({ ...frozen, schema: SCHEMA - 1 })).toMatchObject({ ok: false, problem: `the frozen log is of schema ${SCHEMA - 1}` })
  })

  it('is what the same writes give today', () => {
    // the other direction: today's code, writing these ops live, reaches the frozen state
    const again = write()
    expect(again.state_hash).toBe(frozen.state_hash)
    expect(again.refused.map(r => r.error)).toEqual(frozen.refused.map(r => r.error))
  })
})
