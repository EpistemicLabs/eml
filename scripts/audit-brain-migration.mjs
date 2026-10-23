#!/usr/bin/env node
// Audit a brain migration on a copy (rule eml-deploy-audit): counts before and
// after, on a COPY of the given brain file — the brain itself is never opened
// for writing. Run it in the release step against a copy of the production
// brain, after `pnpm run build`:
//
//   node scripts/audit-brain-migration.mjs <path/to/brain.db>
//
// Prints rows per table, the distribution per type × status, timestamp formats
// per column and the review_due_at formats, before and after; exits 1 when the
// migration lost or added rows, left a non-ISO timestamp, an expired engram,
// an expires_at or the labels tables, or fails the integrity / foreign-key check.

import { copyFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'packages', 'core', 'package.json'))
const Database = require('better-sqlite3')
const { EML, CURRENT_BRAIN_SCHEMA_VERSION } = require(join(root, 'packages', 'core', 'dist', 'index.js'))

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
    }
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

  console.log(JSON.stringify({ source, before, after, problems }, null, 2))
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):\n- ${problems.join('\n- ')}`)
    process.exit(1)
  }
  console.error(`\nmigration audit ok: schema ${before.schema} → ${after.schema}, ${after.rows.engrams} engrams, ${before.expired} expired → invalidated, ${before.labels ? before.labels.engram_labels : 0} label rows dropped`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
