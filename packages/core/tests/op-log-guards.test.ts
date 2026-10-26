import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { CURRENT_BRAIN_SCHEMA_VERSION } from '../src'

// v0.21 (spec local-op-log-spec, block 5): the guards that keep the op log
// whole. A brain is its log only while every write goes through it, and only
// while the runner knows how to log a schema step.

const SRC = join(__dirname, '..', 'src')

// The brain's tables, from the fresh schema: a write to one of them outside
// the write path would change the brain without an entry in its log.
const BRAIN_TABLES = [...readFileSync(join(__dirname, '..', 'migrations', 'brain', `v0.${CURRENT_BRAIN_SCHEMA_VERSION}.sql`), 'utf-8')
  .matchAll(/CREATE (?:VIRTUAL )?TABLE (\w+)/g)].map(m => m[1])

describe('no brain write outside the op log', () => {
  const ALLOWED_DIRS = ['commands/', 'write/', 'log/']  // the commands, their helpers, and the log that runs them
  const ALLOWED = new Set([
    'entries.ts',            // the journal helper the command modules call
    'database.ts', 'forward-migrations.ts',  // the migration runner (and its genesis)
  ])
  // the control DB's files: their users table shares the name with the brain's — writes to it are theirs
  const CONTROL = new Set(['control.ts', 'tokens.ts', 'provisioning.ts'])
  // over the whole file text, so a statement split across lines is caught too
  const WRITE = new RegExp(`\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+"?(${BRAIN_TABLES.join('|')})\\b`, 'gi')

  it('knows the brain tables', () => {
    expect(BRAIN_TABLES).toEqual(expect.arrayContaining(['engrams', 'relations', 'entries', 'agents', 'op_log', 'op_snapshots', 'engrams_fts']))
  })

  const files = (readdirSync(SRC, { recursive: true }) as string[])
    .filter(f => f.endsWith('.ts') && !ALLOWED.has(f) && !ALLOWED_DIRS.some(d => f.startsWith(d)))
    .sort()
  for (const file of files) {
    it(file, () => {
      const text = readFileSync(join(SRC, file), 'utf-8')
      const hits = [...text.matchAll(WRITE)]
        .filter(m => !(CONTROL.has(file) && m[1].toLowerCase() === 'users'))
        .map(m => `${file}:${text.slice(0, m.index).split('\n').length} writes ${m[1]}`)
      expect(hits).toEqual([])
    })
  }
})

describe('a schema step is an op in the log', () => {
  it('the schema stays at 21 until the runner logs a migration', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION, [
      `Brain schema ${CURRENT_BRAIN_SCHEMA_VERSION} > 21, but the migration runner cannot log a schema step yet.`,
      'Before this bump, build the schema migration as an op (local-op-log-spec §6): the runner applies',
      'v0.N_migrate.sql and appends schema.migrate {from, to, state_hash} plus a snapshot at that seq;',
      'a rebuild starts from the newest snapshot at or after the last schema.migrate, refuses an op whose',
      'schema is not its segment\'s and a snapshot newer than the code. Then replace this guard with tests of that path.',
    ].join('\n')).toBe(21)
  })
})
