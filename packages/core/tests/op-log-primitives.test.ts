import { describe, it, expect } from 'vitest'
import { createHash } from 'crypto'
import { EML, NO_ACTOR } from '../src'
import { canonicalJson } from '../src/log/canonical'
import { GENESIS_PREV_HASH, chainHash, encodePayload, opIds, sha256Hex, uuidv5, type OpEnvelope } from '../src/log/op'
import { decodeSnapshot, encodeSnapshot, stateDump, stateHash } from '../src/log/snapshot'
import { validDecision, validNote, writes } from './fixtures'

// v0.21 (spec local-op-log-spec, block 1): the pieces the op log is built from —
// canonical JSON, ids derived from the op, payload and chain hashes, the state
// dump with its hash, the snapshot codec.

const raw = (eml: EML): any => (eml as any).db

describe('canonical JSON', () => {
  it('sorts keys by UTF-16 code unit, at every level, without whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}')
  })

  it('orders keys as RFC 8785 §3.2.3 does', () => {
    const value = {
      '€': 'Euro Sign', '\r': 'Carriage Return', 'דּ': 'Hebrew Letter Dalet With Dagesh', '1': 'One',
      '😀': 'Emoji: Grinning Face', '\u0080': 'Control', 'ö': 'Latin Small Letter O With Diaeresis',
    }
    // read the order off the text: Object.keys would list the integer-like "1" first
    const text = canonicalJson(value)
    const order = Object.keys(value).sort((a, b) => text.indexOf(JSON.stringify(a) + ':') - text.indexOf(JSON.stringify(b) + ':'))
    expect(order).toEqual(['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ'])
  })

  it('prints numbers and strings as JSON.stringify does (RFC 8785 for these values)', () => {
    expect(canonicalJson([1.0, 4.50, 2e-3, 1e30, -0, 0.000001, 1e-7, 9007199254740991])).toBe('[1,4.5,0.002,1e+30,0,0.000001,1e-7,9007199254740991]')
    expect(canonicalJson('a "quote", a \\ and \n\u0007 é 😀')).toBe(JSON.stringify('a "quote", a \\ and \n\u0007 é 😀'))
  })

  it('leaves out keys whose value is undefined, as an absent optional field', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
  })

  it('refuses what is not plain JSON instead of coercing it', () => {
    for (const bad of [NaN, Infinity, new Date(0), Buffer.from('x'), () => 1, 1n, [undefined], new Map(), { nested: [Symbol('s')] }]) {
      expect(() => canonicalJson(bad), String(bad)).toThrow(/^Invalid command: the input must be plain JSON/)
    }
    expect(() => canonicalJson({ a: { b: [1, NaN] } })).toThrow('$.a.b[1] is NaN')
  })

  it('takes objects without a prototype', () => {
    const o = Object.create(null) as Record<string, number>
    o.b = 2; o.a = 1
    expect(canonicalJson(o)).toBe('{"a":1,"b":2}')
  })
})

describe('uuidv5', () => {
  const DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

  it('matches the RFC 9562 test vector (A.4) and another known value', () => {
    expect(uuidv5(DNS, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
    expect(uuidv5(DNS, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d')
    expect(uuidv5(DNS.toUpperCase(), 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2')
  })

  it('refuses a namespace that is not a UUID', () => {
    expect(() => uuidv5('not-a-uuid', 'x')).toThrow(/namespace must be a UUID/)
  })

  it('an op draws uuidv5(op_id, "0"), ("1"), … — the same sequence every time', () => {
    const opId = '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e'
    const a = opIds(opId)
    const b = opIds(opId)
    const first = [a(), a(), a()]
    expect([b(), b(), b()]).toEqual(first)
    expect(first).toEqual([uuidv5(opId, '0'), uuidv5(opId, '1'), uuidv5(opId, '2')])
    expect(new Set(first).size).toBe(3)
    for (const id of first) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(opIds('0e1f2a3b-4c5d-4e6f-8a7b-9c0d1e2f3a4b')()).not.toBe(first[0])
  })
})

describe('payload and chain hashes', () => {
  const op: OpEnvelope = {
    op_id: '9b2f3c1e-4d5a-4b6c-8d7e-0f1a2b3c4d5e',
    schema: 21,
    call: 'engram.create',
    args: { type: 'note', scope: 'global', title: 'n', content: 'c' },
    provenance: { ...NO_ACTOR, handle: 'juno', ingestion_method: 'mcp' },
  }

  it('the payload is the envelope as canonical JSON; its hash is sha256 of the UTF-8 bytes', () => {
    const payload = encodePayload(op)
    expect(payload.startsWith('{"args":{"content":"c","scope":"global","title":"n","type":"note"},"call":"engram.create","op_id":')).toBe(true)
    expect(encodePayload({ provenance: op.provenance, args: { content: 'c', title: 'n', scope: 'global', type: 'note' }, call: op.call, schema: 21, op_id: op.op_id })).toBe(payload)
    expect(sha256Hex(payload)).toBe(createHash('sha256').update(Buffer.from(payload, 'utf8')).digest('hex'))
    expect(sha256Hex('é')).toBe(sha256Hex(Buffer.from([0xc3, 0xa9])))
  })

  it('the chain link hashes prev_hash, seq, at and payload_hash (frozen vector)', () => {
    const empty = sha256Hex('{}')
    expect(empty).toBe('44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a')
    expect(chainHash(GENESIS_PREV_HASH, 1, '2026-10-26T08:00:00.000Z', empty)).toBe('3804054c5c22b6ad9230b59b1379fe9f4d13c92d073d00a25654b2b046048d5b')
  })

  it('a change to any part changes the link', () => {
    const p = sha256Hex(encodePayload(op))
    const base = chainHash(GENESIS_PREV_HASH, 1, '2026-10-26T08:00:00.000Z', p)
    expect(chainHash(GENESIS_PREV_HASH, 2, '2026-10-26T08:00:00.000Z', p)).not.toBe(base)
    expect(chainHash(GENESIS_PREV_HASH, 1, '2026-10-26T08:00:00.001Z', p)).not.toBe(base)
    expect(chainHash(base, 1, '2026-10-26T08:00:00.000Z', p)).not.toBe(base)
    expect(chainHash(GENESIS_PREV_HASH, 1, '2026-10-26T08:00:00.000Z', sha256Hex('{}'))).not.toBe(base)
  })

  it('refuses malformed parts', () => {
    const p = sha256Hex('{}')
    expect(() => chainHash('abc', 1, '2026-10-26T08:00:00.000Z', p)).toThrow(/hashes/)
    expect(() => chainHash(GENESIS_PREV_HASH.toUpperCase().replace(/0/g, 'A'), 1, '2026-10-26T08:00:00.000Z', p)).toThrow(/hashes/)
    expect(() => chainHash(GENESIS_PREV_HASH, 0, '2026-10-26T08:00:00.000Z', p)).toThrow(/seq/)
    expect(() => chainHash(GENESIS_PREV_HASH, 1.5, '2026-10-26T08:00:00.000Z', p)).toThrow(/seq/)
    expect(() => chainHash(GENESIS_PREV_HASH, 1, '2026-10-26 08:00:00', p)).toThrow(/at/)
  })
})

describe('state dump, state hash and snapshots', () => {
  function brain(): EML {
    let t = Date.parse('2026-10-26T08:00:00.000Z')
    let n = 0
    return new EML({
      dbPath: ':memory:', namespace: 'test',
      clock: () => new Date(t++).toISOString(),
      newId: () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, '0')}`,
    })
  }
  function fill(eml: EML): void {
    const env = eml.env({ handle: 'juno' })
    const d = writes(eml).store(validDecision({ title: 'pick' }), env)
    writes(eml).store(validNote({ title: 'see', content: 'see [[pick]]' }), env)
    writes(eml).update(d.id, { content: 'picked again' }, env)
  }

  it('covers every state table and leaves out the migration ledger and the FTS shadow tables', () => {
    const eml = brain()
    const tables = Object.keys(stateDump(raw(eml)))
    expect(tables).toEqual(expect.arrayContaining(['agents', 'engrams', 'engrams_fts', 'entries', 'relations', 'users']))
    expect(tables).not.toContain('_eml_migrations')
    expect(tables.filter(t => t.startsWith('engrams_fts_'))).toEqual([])
    expect(tables).toEqual([...tables].sort())
    eml.close()
  })

  it('orders rows by primary key; the fts table carries its rowid', () => {
    const eml = brain()
    fill(eml)
    const dump = stateDump(raw(eml))
    const ids = dump.engrams.map(r => r.id as string)
    expect(ids).toEqual([...ids].sort())
    expect(dump.engrams_fts.length).toBe(dump.engrams.length)
    const rowids = dump.engrams_fts.map(r => r.rowid as number)
    expect(rowids.every(n => Number.isInteger(n))).toBe(true)
    expect(rowids).toEqual([...rowids].sort((a, b) => a - b))
    eml.close()
  })

  it('equal states hash equal; one more write changes the hash', () => {
    const a = brain(); const b = brain()
    fill(a); fill(b)
    const h = stateHash(stateDump(raw(a)))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(stateHash(stateDump(raw(b)))).toBe(h)
    writes(b).store(validNote({ title: 'one-more' }), b.env())
    expect(stateHash(stateDump(raw(b)))).not.toBe(h)
    a.close(); b.close()
  })

  it('the hash does not depend on key order inside a row', () => {
    const a = brain()
    fill(a)
    const dump = stateDump(raw(a))
    const shuffled = Object.fromEntries(Object.entries(dump).reverse().map(([t, rows]) => [t, rows.map(r => Object.fromEntries(Object.entries(r).reverse()))]))
    expect(stateHash(shuffled)).toBe(stateHash(dump))
    a.close()
  })

  it('a snapshot decodes to the dump it encoded, with the same hash', () => {
    const eml = brain()
    fill(eml)
    const dump = stateDump(raw(eml))
    const data = encodeSnapshot(dump)
    expect(data[0]).toBe(0x1f); expect(data[1]).toBe(0x8b)  // gzip
    const back = decodeSnapshot(data)
    expect(back).toEqual(JSON.parse(JSON.stringify(dump)))
    expect(stateHash(back)).toBe(stateHash(dump))
    eml.close()
  })
})
