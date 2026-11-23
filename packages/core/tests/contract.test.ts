import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { canonicalJson, sha256Hex } from '@engramprotocol/protocol/log'
import { EML, CommandError, COMMAND_NAMES, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { CONTRACTS_DIR } from '../src/database'
import { CALL_KEYS, unknownKeys } from '../src/contract/calls'
import { contractDocument, contractId, contractJson } from '../src/contract/document'
import { readFrozenLog } from '../src/contract/frozen'
import { selfTest } from '../src/log/self-test'
import { validDecision, validNote, validTask, writes } from './fixtures'

// The contract of the current brain schema (contracts/v<N>.json): the document
// generated from core's tables, checked in with its id. One contract per
// schema: when this test fails, the change under test makes another contract,
// and that is a new brain schema (CLAUDE.md), not a new file. The file is
// written again only with a schema bump, together with the frozen log it
// names: `EML_FREEZE_LOG=1 pnpm -F @engramprotocol/core test frozen-log contract`
// (the log first), and the diff is reviewed like code. A release signs
// {schema, contract}; its signature file sits next to this one.

const SCHEMA = CURRENT_BRAIN_SCHEMA_VERSION
const FILE = join(CONTRACTS_DIR, `v${SCHEMA}.json`)

if (process.env.EML_FREEZE_LOG === '1') {
  writeFileSync(FILE, JSON.stringify({ schema: SCHEMA, contract: sha256Hex(contractJson()), document: JSON.parse(contractJson()) }, null, 2) + '\n')
}

describe(`the contract of brain schema ${SCHEMA}`, () => {
  it('is checked in for the schema this code writes', () => {
    expect(existsSync(FILE), `no contract for schema ${SCHEMA} (${FILE})`).toBe(true)
  })
  if (!existsSync(FILE)) return
  const file = JSON.parse(readFileSync(FILE, 'utf-8')) as { schema: number, contract: string, document: unknown }

  it('is the document this code generates, with its id', () => {
    expect(file.schema).toBe(SCHEMA)
    expect(canonicalJson(file.document)).toBe(contractJson())
    expect(file.contract).toBe(sha256Hex(canonicalJson(file.document)))
    expect(contractId()).toBe(file.contract)
  })

  it('names the schema and the state its frozen log replays to', () => {
    const document = contractDocument() as { schema: number, frozen_log: { state_hash: string } }
    expect(document.schema).toBe(SCHEMA)
    expect(document.frozen_log.state_hash).toBe(readFrozenLog().state_hash)
  })

  it('has a key table for every command', () => {
    expect(Object.keys(CALL_KEYS).sort()).toEqual([...COMMAND_NAMES].sort())
  })

  it('is another contract, and a failed self-test, for a build whose table takes one more key', () => {
    // the case of 2026-11-21: one build took done_when on task.track, the release refused it
    const table = CALL_KEYS['task.track'] as Record<string, unknown>
    table.done_when = 'value'
    try {
      expect(sha256Hex(contractJson())).not.toBe(file.contract)
      expect(selfTest()).toMatchObject({ ok: false, problem: expect.stringContaining('a write the frozen log refuses was taken: task.track') })
    } finally {
      delete table.done_when
    }
    expect(sha256Hex(contractJson())).toBe(file.contract)
    expect(selfTest().ok).toBe(true)
  })
})

describe('unknownKeys', () => {
  it('names the keys a table does not have, in the input\'s order', () => {
    expect(unknownKeys({ b: 1, id: 'x', a: null }, { id: 'value' })).toEqual(['b', 'a'])
    expect(unknownKeys({ id: 'x' }, { id: 'value' })).toEqual([])
  })

  it('takes a name every object inherits as unknown', () => {
    const input = JSON.parse('{"toString":"x","constructor":"y","__proto__":"z","hasOwnProperty":1}') as object
    expect(unknownKeys(input, { id: 'value' })).toEqual(['toString', 'constructor', '__proto__', 'hasOwnProperty'])
  })
})

// Every command refuses a key its call does not take. These are the places
// that took one and ignored it (or stored it) up to schema 21.
describe('keys no call takes are refused (schema 22)', () => {
  let eml: EML
  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'contract' })
    writes(eml).projects.create({ id: 'q', name: 'Q' })
    writes(eml).agents.store({ id: 'juno', name: 'Juno' })
  })
  afterEach(() => eml.close())

  const refused = (name: string, input: unknown, message: string | RegExp) => {
    let error: unknown
    try { eml.apply({ name, input } as never) } catch (err) { error = err }
    expect(error, `${name} was not refused`).toBeInstanceOf(CommandError)
    expect((error as CommandError).code).toBe('INVALID')
    if (typeof message === 'string') expect((error as CommandError).message).toBe(message)
    else expect((error as CommandError).message).toMatch(message)
  }
  const note = () => writes(eml).store(validNote({ scope: 'project.q' }))
  const decision = () => writes(eml).store(validDecision({ scope: 'project.q' }))

  it('engram.confirm_review: its input', () => {
    const d = decision()
    refused('engram.confirm_review', { id: d.id, text: 'holds', why: 'x' }, 'Invalid command: unknown field why — engram.confirm_review takes id and text.')
    expect(eml.engrams.entries(d.id, ['review'])).toEqual([])
  })

  it('object.create: its envelope', () => {
    refused('object.create', { object: 'tag', fields: { name: 'ops' }, id: 'ops' }, 'Invalid command: unknown field id — object.create takes object and fields.')
    expect(eml.tags.exists('ops')).toBe(false)
  })

  it('object.update: its envelope', () => {
    refused('object.update', { object: 'project', id: 'q', patch: { goal: 'g' }, fields: {} }, 'Invalid command: unknown field fields — object.update takes object, id and patch.')
    expect(eml.projects.get('q')?.goal ?? null).toBeNull()
  })

  it('engram.move_out: its target', () => {
    const n = note()
    refused('engram.move_out', { ids: [n.id], set_hash: '0'.repeat(64), drop_relations: [], target: { brain: 'b', op_id: 'o', seq: 2 } },
      'Invalid command: engram.move_out: unknown field seq in target — it takes brain and op_id.')
  })

  it('engram.update: its envelope', () => {
    const n = note()
    refused('engram.update', { id: n.id, patch: { content: 'changed' }, rev: 1, force: true }, 'Invalid command: unknown fields rev, force — engram.update takes id, patch and base_rev.')
    expect(eml.engrams.get(n.id)?.content).toBe(n.content)
  })

  it('engram.import: its source', () => {
    refused('engram.import', { source: { brain: 'b', head_seq: 1, name: 'x' }, set_hash: '', rows: {} },
      'Invalid command: engram.import: unknown field name in source — it takes brain and head_seq.')
  })

  it('a name every object inherits: in an engram\'s fields, on create and on update', () => {
    refused('engram.create', { ...validNote({ scope: 'project.q' }), properties: { toString: 'x' } }, 'Invalid engram: unknown field toString for a note. Allowed: binding, detail.')
    const n = note()
    refused('engram.update', { id: n.id, patch: { properties: { constructor: 'x' } } }, 'Invalid engram: unknown field constructor for a note. Allowed: binding, detail.')
    expect(eml.engrams.get(n.id)?.properties).toEqual({})
  })

  it('a name every object inherits: in an object\'s fields, on create and on update', () => {
    refused('object.create', { object: 'tag', fields: { name: 'ops', valueOf: 'x' } }, 'Invalid object: unknown field valueOf for a tag. Allowed: name, description, status.')
    refused('object.update', { object: 'project', id: 'q', patch: { toString: 'x' } }, /^Invalid object: unknown field toString for a project\. Allowed: name, /)
  })

  it('engram.create: an unknown field with null, like any other value', () => {
    refused('engram.create', { ...validNote({ scope: 'project.q' }), properties: { verdict: null } }, 'Invalid engram: unknown field verdict for a note. Allowed: binding, detail.')
    // a field of the type with null is one that is not set
    const n = writes(eml).store({ ...validNote({ scope: 'project.q' }), properties: { detail: null } } as never)
    expect(n.properties).toEqual({})
  })

  describe('engram.create of a learning: the lesson at the top, the incident in evidence', () => {
    const lesson = { type: 'learning', scope: 'agent.juno', title: 'ask-first', content: 'Ask before acting.' }
    const evidence = { source: 'observed', happened: 'once' }

    it('refuses a lesson key in evidence', () => {
      refused('engram.create', { ...lesson, evidence: { ...evidence, title: 'another', content: 'Another lesson.' } },
        'Invalid command: unknown fields title, content in evidence — it takes source, happened, quote, stance and rule_id.')
    })

    it('refuses an evidence key, or an id, at the top', () => {
      refused('engram.create', { ...lesson, source: 'self', evidence }, 'Invalid command: unknown field source — engram.create of a learning takes type, scope, title, content, tags, subjects, new_topic and evidence.')
      refused('engram.create', { ...lesson, id: 'x', evidence }, /^Invalid command: unknown field id — engram\.create of a learning takes /)
    })

    it('answers a key eml_learning does not have as before', () => {
      refused('engram.create', { ...lesson, mood: 'x', evidence }, /^Invalid engram: unknown field mood for a learning\. Allowed: id, content, scope, /)
    })

    it('takes the split shape', () => {
      const r = eml.apply({ name: 'engram.create', input: { ...lesson, new_topic: true, evidence: { ...evidence, stance: 'supports' } } as never })
      expect(r.title).toBe('ask-first')
      expect(r.content).toBe('Ask before acting.')
    })
  })

  it('task.track: the key of 2026-11-21', () => {
    const t = writes(eml).store(validTask({ scope: 'project.q' }))
    refused('task.track', { id: t.id, text: 'progress', done_when: 'it ships' }, /^Invalid engram: unknown field done_when for a task\. Allowed: text, status, /)
    expect(eml.engrams.entries(t.id, ['note'])).toEqual([])
  })
})
