#!/usr/bin/env node
// Audit a brain migration on a copy (rule eml-deploy-audit): counts before and
// after, on a COPY of the given brain file — the brain itself is never opened
// for writing. Run it in the release step against a copy of the production
// brain, after `pnpm run build`:
//
//   node scripts/audit-brain-migration.mjs <path/to/brain.db>
//
// Prints rows per table, the distribution per type × status, timestamp formats
// per column, the review_due_at formats, the state hash and the sizes (brain
// file, op_log, op_snapshots), before and after; exits 1 when the migration
// lost or added rows, left a non-ISO timestamp, an expired engram, an
// expires_at or the labels tables, fails the integrity / foreign-key check, or
// (schema 21) left the op log without exactly one valid genesis whose snapshot
// holds the migrated state, or a log a rebuild from does not equal the brain —
// or changed the state when it only had to add the log.

import { copyFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'packages', 'core', 'package.json'))
const Database = require('better-sqlite3')
const { EML, CURRENT_BRAIN_SCHEMA_VERSION, GENESIS_PREV_HASH, chainHash, sha256Hex, stateDump, stateHash, decodeSnapshot } = require(join(root, 'packages', 'core', 'dist', 'index.js'))
const { verify } = require(join(root, 'packages', 'core', 'dist', 'log', 'rebuild.js'))

const source = process.argv[2]
if (!source || !existsSync(source)) {
  console.error('usage: node scripts/audit-brain-migration.mjs <path/to/brain.db>')
  process.exit(2)
}

const ROW_TABLES = ['agents', 'users', 'entities', 'projects', 'engrams', 'relations', 'tags', 'engram_tags', 'subjects', 'engram_subjects', 'entries']
const TIME_COLUMNS = {
  agents: ['created_at'], users: ['created_at', 'updated_at'], entities: ['created_at', 'updated_at'],
  projects: ['created_at', 'updated_at'], engrams: ['created_at', 'updated_at'], relations: ['created_at'],
  tags: ['created_at'], engram_tags: ['created_at'], subjects: ['created_at', 'updated_at'],
  engram_subjects: ['created_at'], entries: ['at'],
}
const FORMAT = `CASE
  WHEN v IS NULL THEN 'null'
  WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z' THEN 'iso-ms'
  WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]' THEN 'sqlite'
  WHEN v GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' THEN 'date'
  ELSE 'other' END`

function stats(file) {
  const db = new Database(file, { readonly: true })
  const has = (t) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(t)
  try {
    const formats = {}
    for (const [table, cols] of Object.entries(TIME_COLUMNS)) {
      for (const col of cols) {
        formats[`${table}.${col}`] = Object.fromEntries(db.prepare(`SELECT ${FORMAT} AS f, COUNT(*) AS n FROM (SELECT ${col} AS v FROM ${table}) GROUP BY f ORDER BY f`).all().map(r => [r.f, r.n]))
      }
    }
    return {
      schema: db.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get().v,
      rows: Object.fromEntries(ROW_TABLES.map(t => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])),
      labels: has('labels') ? { labels: db.prepare('SELECT COUNT(*) AS n FROM labels').get().n, engram_labels: db.prepare('SELECT COUNT(*) AS n FROM engram_labels').get().n } : null,
      byTypeStatus: Object.fromEntries(db.prepare(`SELECT type || ' · ' || status AS k, COUNT(*) AS n FROM engrams GROUP BY k ORDER BY k`).all().map(r => [r.k, r.n])),
      expired: db.prepare(`SELECT COUNT(*) AS n FROM engrams WHERE status = 'expired'`).get().n,
      expiresAt: db.prepare(`SELECT COUNT(*) AS n FROM engrams WHERE json_valid(properties) AND json_extract(properties, '$.expires_at') IS NOT NULL`).get().n,
      reviewDueAt: Object.fromEntries(db.prepare(`SELECT ${FORMAT} AS f, COUNT(*) AS n FROM (SELECT json_extract(properties, '$.review_due_at') AS v FROM engrams WHERE json_valid(properties) AND json_type(properties, '$.review_due_at') = 'text') GROUP BY f ORDER BY f`).all().map(r => [r.f, r.n])),
      formats,
      integrity: db.pragma('integrity_check', { simple: true }),
      fkViolations: db.pragma('foreign_key_check').length,
      stateHash: stateHash(stateDump(db)),
      sizes: sizes(db, file),
    }
  } finally { db.close() }
}

/** Bytes on disk: the brain file (with its WAL) and the pages of the log tables. */
function sizes(db, file) {
  const pages = Object.fromEntries(db.prepare(`SELECT name, SUM(pgsize) AS bytes FROM dbstat WHERE name IN ('op_log', 'op_snapshots') GROUP BY name`).all().map(r => [r.name, r.bytes]))
  const wal = existsSync(file + '-wal') ? statSync(file + '-wal').size : 0
  return { file: statSync(file).size + wal, op_log: pages.op_log ?? 0, op_snapshots: pages.op_snapshots ?? 0 }
}

/** Schema 21: the log holds exactly the genesis, its link is valid, and it and its snapshot hold the brain's state. */
function genesisProblems(file) {
  const db = new Database(file, { readonly: true })
  try {
    const problems = []
    const log = db.prepare('SELECT * FROM op_log ORDER BY seq').all()
    if (log.length !== 1) return [`op_log has ${log.length} entries, expected the genesis alone`]
    const g = log[0]
    const state = stateHash(stateDump(db))
    const payload = JSON.parse(g.payload)
    if (g.seq !== 1 || g.prev_hash !== GENESIS_PREV_HASH) problems.push('genesis is not seq 1 after the zero hash')
    if (g.payload_hash !== sha256Hex(g.payload)) problems.push('genesis payload_hash does not match its payload')
    if (g.hash !== chainHash(g.prev_hash, g.seq, g.at, g.payload_hash)) problems.push('genesis chain link is not valid')
    if (payload.call !== 'brain.genesis' || payload.schema !== CURRENT_BRAIN_SCHEMA_VERSION) problems.push(`genesis payload is ${payload.call} at schema ${payload.schema}`)
    if (payload.args?.state_hash !== state) problems.push('genesis state_hash is not the hash of the migrated brain')
    const snaps = db.prepare('SELECT seq, schema, state_hash, data FROM op_snapshots').all()
    if (snaps.length !== 1 || snaps[0].seq !== 1 || snaps[0].schema !== CURRENT_BRAIN_SCHEMA_VERSION) problems.push(`expected one snapshot at seq 1, schema ${CURRENT_BRAIN_SCHEMA_VERSION}`)
    else {
      if (snaps[0].state_hash !== state) problems.push('snapshot state_hash is not the hash of the migrated brain')
      if (stateHash(decodeSnapshot(snaps[0].data)) !== state) problems.push('snapshot data does not decode to the migrated brain')
    }
    // and the brain is its log: a rebuild from the genesis equals the migrated state
    const verified = verify(db)
    if (!verified.ok) problems.push(`the log does not verify: ${verified.problem}`)
    return problems
  } finally { db.close() }
}

const work = mkdtempSync(join(tmpdir(), 'eml-audit-'))
const copy = join(work, 'brain.db')
copyFileSync(source, copy)
for (const ext of ['-wal', '-shm']) if (existsSync(source + ext)) copyFileSync(source + ext, copy + ext)

try {
  const before = stats(copy)
  new EML({ namespace: 'audit', dbPath: copy }).close()
  const after = stats(copy)

  const problems = []
  for (const t of ROW_TABLES) if (before.rows[t] !== after.rows[t]) problems.push(`${t}: ${before.rows[t]} rows before, ${after.rows[t]} after`)
  if (after.schema !== CURRENT_BRAIN_SCHEMA_VERSION) problems.push(`schema ${after.schema}, expected ${CURRENT_BRAIN_SCHEMA_VERSION}`)
  if (after.labels) problems.push('labels tables still there')
  if (after.expired > 0) problems.push(`${after.expired} engrams still expired`)
  if (after.expiresAt > 0) problems.push(`${after.expiresAt} engrams still carry expires_at`)
  for (const [col, f] of Object.entries(after.formats)) {
    const bad = Object.entries(f).filter(([k]) => k !== 'iso-ms')
    if (bad.length > 0) problems.push(`${col}: ${bad.map(([k, n]) => `${n} ${k}`).join(', ')}`)
  }
  const badDue = Object.entries(after.reviewDueAt).filter(([k]) => k !== 'iso-ms')
  if (badDue.length > 0) problems.push(`review_due_at: ${badDue.map(([k, n]) => `${n} ${k}`).join(', ')}`)
  // type × status: only expired → invalidated may move
  const moved = { ...before.byTypeStatus }
  for (const [k, n] of Object.entries(moved)) {
    if (k.endsWith(' · expired')) {
      const inv = k.replace(' · expired', ' · invalidated')
      moved[inv] = (moved[inv] ?? 0) + n
      delete moved[k]
    }
  }
  for (const k of new Set([...Object.keys(moved), ...Object.keys(after.byTypeStatus)])) {
    if ((moved[k] ?? 0) !== (after.byTypeStatus[k] ?? 0)) problems.push(`${k}: ${moved[k] ?? 0} expected, ${after.byTypeStatus[k] ?? 0} after`)
  }
  if (after.integrity !== 'ok') problems.push(`integrity_check: ${after.integrity}`)
  if (after.fkViolations > 0) problems.push(`${after.fkViolations} foreign-key violations`)
  problems.push(...genesisProblems(copy))
  // from 20, the one step to 21 only adds the log: the state must be unchanged
  if (before.schema === 20 && after.stateHash !== before.stateHash) problems.push('the state changed, but the step to 21 only adds the op log')

  console.log(JSON.stringify({ source, before, after, problems }, null, 2))
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }
  const kb = (n) => `${(n / 1024).toFixed(0)} KiB`
  console.error(`\nmigration audit ok: schema ${before.schema} → ${after.schema}, ${after.rows.engrams} engrams, ${before.expired} expired → invalidated, ${before.labels ? before.labels.engram_labels : 0} label rows dropped`)
  console.error(`sizes: file ${kb(before.sizes.file)} → ${kb(after.sizes.file)}, op_log ${kb(after.sizes.op_log)}, op_snapshots ${kb(after.sizes.op_snapshots)}`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
