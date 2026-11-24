import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { EML } from '../src'
import { validNote, writes } from './fixtures'

// scripts/audit-brain-migration.mjs, the release gate, on a brain from schema 21 on (it runs on the built
// packages, which CI builds before it tests): the log has to verify; after a step it has to end in the checkpoint.

const SCRIPT = join(__dirname, '..', '..', '..', 'scripts', 'audit-brain-migration.mjs')
const audit = (file: string) => spawnSync(process.execPath, [SCRIPT, file], { encoding: 'utf8' })

describe('the migration audit on a brain with a live op log', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eml-audit-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const brain = () => {
    const file = join(dir, 'brain.db')
    const eml = new EML({ namespace: 'test', dbPath: file })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
    writes(eml).store(validNote({ scope: 'project.eml', title: 'kept' }))
    eml.close()
    return file
  }

  it('passes a brain at the current schema whose log verifies: no step, so no new checkpoint is asked for', () => {
    const r = audit(brain())
    expect(r.stderr).toContain('migration audit ok')
    expect(r.status).toBe(0)
  })

  it('fails a brain whose log does not verify', () => {
    const file = brain()
    const db = new Database(file)
    db.prepare("UPDATE op_log SET payload = replace(payload, 'kept', 'changed') WHERE seq = (SELECT MAX(seq) FROM op_log)").run()
    db.close()
    const r = audit(file)
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('the op log does not verify')
  })
})
