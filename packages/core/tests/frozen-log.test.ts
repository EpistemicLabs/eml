import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import Database from 'better-sqlite3'
import { canonicalJson } from '@engramprotocol/protocol/log'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION, initDatabase, type Actor } from '../src'
import { COMMAND_NAMES } from '../src/commands'
import { rebuild, verify } from '../src/log/rebuild'
import { stateDump, stateHash } from '../src/log/snapshot'
import { validDecision, validNote, validRule, validTask, writes, writeEverything } from './fixtures'

// The frozen log of the current brain schema (fixtures/log-v<N>.json): a log
// that calls every command, the hash of the state it replays to, and writes
// the brain refuses on that state with what it answers. What a logged op does
// is part of the log format — validation, enums, limits, scope patterns, the
// learning topic gate, defaults, change-entry texts, slugs, wikilinks. Every
// replica and every later rebuild must derive the same state from the same
// log, on every platform, so this test replays the file as it was written
// and compares.
//
// When it fails, the change under test makes an existing log replay to another
// state. That is a new brain schema (CLAUDE.md), not a new fixture. The file
// is written again only with a schema bump or to cover a new command:
// `EML_FREEZE_LOG=1 pnpm -F @engramprotocol/core test frozen-log`, and the
// diff is reviewed like code.

const SCHEMA = CURRENT_BRAIN_SCHEMA_VERSION
const FILE = join(__dirname, 'fixtures', `log-v${SCHEMA}.json`)
const BRAIN = '6f1d2c3b-4a59-4e68-9b7a-0c1d2e3f4a5b'
const START = Date.parse('2026-11-19T08:00:00.000Z')
/** The time the refused writes are tried at: after every entry of the log. */
const LATER = '2026-11-20T08:00:00.000Z'

interface Entry { seq: number, at: string, op_id: string, prev_hash: string, payload_hash: string, hash: string, payload: string }
interface Refused { name: string, input: unknown, actor: Actor, error: { code: string, message: string, data: unknown } }
interface Frozen {
  schema: number
  state_hash: string
  /** the genesis snapshot's stored bytes, base64 */
  genesis: { state_hash: string, data: string }
  entries: Entry[]
  refused: Refused[]
}

const raw = (eml: EML): Database.Database => (eml as any).db

function refusal(eml: EML, name: string, input: unknown, actor: Actor): Refused['error'] {
  try {
    eml.apply({ name, input } as never, { now: () => LATER, newId: () => '99999999-0000-4000-8000-000000000000', actor })
  } catch (err) {
    const e = err as { code?: string, message: string, data?: unknown }
    return { code: e.code ?? 'ERROR', message: e.message, data: e.data ?? null }
  }
  throw new Error(`${name} was not refused`)
}

/** The brain the file is written from: writeEverything, learnings on neighbouring topics, an update at a revision. */
function write(): Frozen {
  let t = START
  let n = 0
  const eml = new EML({
    dbPath: ':memory:', namespace: 'frozen', brainId: BRAIN,
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
  ]
  const refused = tries.map(([name, input]) => ({ name, input, actor, error: refusal(eml, name, input, actor) }))

  const db = raw(eml)
  const genesis = db.prepare('SELECT state_hash, data FROM op_snapshots WHERE seq = 1').get() as { state_hash: string, data: Buffer }
  const frozen: Frozen = {
    schema: SCHEMA,
    state_hash: eml.stateHash(),
    genesis: { state_hash: genesis.state_hash, data: genesis.data.toString('base64') },
    entries: db.prepare('SELECT seq, at, op_id, prev_hash, payload_hash, hash, payload FROM op_log ORDER BY seq').all() as Entry[],
    refused,
  }
  eml.close()
  return frozen
}

/** The file as a brain: its log loaded as stored, its state rebuilt from it. */
function load(frozen: Frozen): Database.Database {
  const log = initDatabase(':memory:', undefined, BRAIN, { log: false })
  const insert = log.prepare('INSERT INTO op_log (seq, at, op_id, prev_hash, payload_hash, hash, signature, rejected, payload) VALUES (@seq, @at, @op_id, @prev_hash, @payload_hash, @hash, NULL, NULL, @payload)')
  for (const entry of frozen.entries) insert.run(entry)
  log.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (1, ?, ?, ?)').run(frozen.schema, frozen.genesis.state_hash, Buffer.from(frozen.genesis.data, 'base64'))

  const brain = new Database(':memory:')
  rebuild(brain, log)
  for (const entry of frozen.entries) {
    brain.prepare('INSERT INTO op_log (seq, at, op_id, prev_hash, payload_hash, hash, signature, rejected, payload) VALUES (@seq, @at, @op_id, @prev_hash, @payload_hash, @hash, NULL, NULL, @payload)').run(entry)
  }
  brain.prepare('INSERT INTO op_snapshots (seq, schema, state_hash, data) VALUES (1, ?, ?, ?)').run(frozen.schema, frozen.genesis.state_hash, Buffer.from(frozen.genesis.data, 'base64'))
  log.close()
  return brain
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
  const frozen = JSON.parse(readFileSync(FILE, 'utf-8')) as Frozen

  it('calls every command', () => {
    const called = new Set(frozen.entries.map(e => (JSON.parse(e.payload) as { call: string }).call))
    expect(COMMAND_NAMES.filter(name => !called.has(name))).toEqual([])
  })

  it('replays to the state hash it was frozen with, and verifies', () => {
    const brain = load(frozen)
    expect(stateHash(stateDump(brain))).toBe(frozen.state_hash)
    expect(verify(brain)).toEqual({ ok: true, entries: frozen.entries.length, state_hash: frozen.state_hash })
    brain.close()
  })

  it('refuses the same writes with the same answers', () => {
    const brain = load(frozen)
    const eml = EML.fromConnection(brain, 'frozen')
    for (const { name, input, actor, error } of frozen.refused) {
      expect(canonicalJson(refusal(eml, name, input, actor) as never), `${name} ${JSON.stringify(input).slice(0, 80)}`).toBe(canonicalJson(error as never))
    }
    expect(stateHash(stateDump(brain))).toBe(frozen.state_hash)
    brain.close()
  })

  it('is what the same writes give today', () => {
    // the other direction: today's code, writing these ops live, reaches the frozen state
    const again = write()
    expect(again.state_hash).toBe(frozen.state_hash)
    expect(again.refused.map(r => r.error)).toEqual(frozen.refused.map(r => r.error))
  })
})
