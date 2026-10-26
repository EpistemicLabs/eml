#!/usr/bin/env node
// Verify a brain against its op log (spec local-op-log-spec): every entry in
// order, each payload against its hash and each chain link, the genesis
// against its snapshot, then a rebuild from the log compared with the live
// state. Runs on a COPY of the given brain file — the brain itself is only
// read. Run it at release against a copy of the production brain, after
// `pnpm run build`:
//
//   node scripts/verify-brain-log.mjs <path/to/brain.db>
//
// A brain below the current schema is migrated first (on the copy), so the
// genesis is written there. Prints the result; exits 1 when it does not verify.

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'packages', 'core', 'package.json'))
const Database = require('better-sqlite3')
const { EML, CURRENT_BRAIN_SCHEMA_VERSION } = require(join(root, 'packages', 'core', 'dist', 'index.js'))
// verify is not in core's index: rebuild needs the EML class, and an index export would be a require cycle
const { verify } = require(join(root, 'packages', 'core', 'dist', 'log', 'rebuild.js'))

const source = process.argv[2]
if (!source || !existsSync(source)) {
  console.error('usage: node scripts/verify-brain-log.mjs <path/to/brain.db>')
  process.exit(2)
}

const work = mkdtempSync(join(tmpdir(), 'eml-verify-'))
const copy = join(work, 'brain.db')
try {
  const src = new Database(source, { readonly: true, fileMustExist: true })
  try { src.prepare('VACUUM INTO ?').run(copy) } finally { src.close() }

  const probe = new Database(copy, { readonly: true })
  const schema = probe.prepare('SELECT MAX(version) AS v FROM _eml_migrations').get().v
  probe.close()
  if (schema < CURRENT_BRAIN_SCHEMA_VERSION) {
    console.error(`schema ${schema}: migrating the copy to ${CURRENT_BRAIN_SCHEMA_VERSION} first`)
    new EML({ namespace: 'verify', dbPath: copy }).close()
  }

  const db = new Database(copy, { readonly: true })
  let result
  const started = Date.now()
  try { result = verify(db) } finally { db.close() }
  console.log(JSON.stringify({ source, schema, ...result, ms: Date.now() - started }, null, 2))
  if (!result.ok) {
    console.error(`\nlog does not verify: ${result.problem}`)
    process.exit(1)
  }
  console.error(`\nlog verifies: ${result.entries} entries, the rebuild equals the live brain (state ${result.state_hash.slice(0, 12)}…)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
