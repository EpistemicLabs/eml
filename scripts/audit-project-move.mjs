#!/usr/bin/env node
// Audit a project move into another brain (rule eml-deploy-audit; spec
// team-brain-move-project §7): what the source held before, what it holds
// after, what the target holds, and what the agent brains' references say —
// on consistent copies, the brains themselves are never opened for writing.
// Run it after a dry run or the real move, after `pnpm run build`:
//
//   node scripts/audit-project-move.mjs --project <id> \
//     --before <source backup .db: backups/move/<brain>-<time>.db> \
//     --after <source brain .db> --target <target brain .db> \
//     [--agent <agent brain .db>]...
//
// Prints the tree, the counts per type × scope before and after in both
// brains, the entries, links, tags and subjects that moved, the links dropped,
// the projects archived, the agent brains' references, and the integrity of
// both brains (rebuild equals state, no dangling link, every engram has its
// scope object, the search index is complete). Exits 1 when any check fails.

import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const require = createRequire(join(root, 'packages', 'core', 'package.json'))
const Database = require('better-sqlite3')
const { verify } = require(join(root, 'packages', 'core', 'dist', 'log', 'rebuild.js'))

// --- arguments ---

const args = { agent: [] }
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, '')
  const value = process.argv[i + 1]
  if (!['project', 'before', 'after', 'target', 'agent'].includes(key) || value === undefined) usage()
  if (key === 'agent') args.agent.push(value)
  else args[key] = value
}
if (!args.project || !args.before || !args.after || !args.target) usage()
for (const file of [args.before, args.after, args.target, ...args.agent]) {
  if (!existsSync(file)) { console.error(`not found: ${file}`); process.exit(2) }
}

function usage() {
  console.error('usage: node scripts/audit-project-move.mjs --project <id> --before <source backup.db> --after <source.db> --target <target.db> [--agent <agent brain.db>]...')
  process.exit(2)
}

// --- consistent read-only copies (a live brain has a WAL; VACUUM INTO takes a snapshot) ---

const work = mkdtempSync(join(tmpdir(), 'eml-audit-move-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

function snapshot(file, name) {
  const copy = join(work, `${name}.db`)
  const live = new Database(file, { readonly: true })
  try { live.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`) } finally { live.close() }
  return new Database(copy, { readonly: true })
}

const before = snapshot(args.before, 'before')
const after = snapshot(args.after, 'after')
const target = snapshot(args.target, 'target')
const agents = args.agent.map((file, i) => ({ file, db: snapshot(file, `agent-${i}`) }))

// --- helpers ---

const failures = []
function check(ok, what) {
  console.log(`${ok ? '  ok ' : 'FAIL '} ${what}`)
  if (!ok) failures.push(what)
}
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n
const brainIdOf = (db) => db.prepare(`SELECT json_extract(payload, '$.args.brain') AS brain FROM op_log WHERE seq = 1`).get()?.brain ?? null
const inList = (ids) => ids.map(() => '?').join(', ')

// --- the set: the project with its sub-projects, as the source held it before ---

const tree = before.prepare(`
  WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT p.id FROM projects p JOIN sub ON p.parent_project = sub.id)
  SELECT id FROM sub
`).all(args.project).map(r => r.id)
if (tree.length === 0 || !before.prepare('SELECT 1 FROM projects WHERE id = ?').get(args.project)) {
  console.error(`project ${args.project} is not in the source backup`)
  process.exit(2)
}
const scopes = tree.map(id => `project.${id}`)
const setRows = before.prepare(`SELECT id, type, scope FROM engrams WHERE scope IN (${inList(scopes)}) ORDER BY ord`).all(...scopes)
const ids = setRows.map(r => r.id)
const sourceBrain = brainIdOf(before)
const targetBrain = brainIdOf(target)

console.log(`project ${args.project}: ${tree.length} project(s) — ${tree.join(', ')}`)
console.log(`source brain ${sourceBrain} (${basename(args.before)} → ${basename(args.after)}), target brain ${targetBrain}`)
console.log(`set: ${ids.length} engrams`)
console.log('')

// --- distribution per type × scope: before in the source, after in the source and in the target ---

const dist = (db) => Object.fromEntries(
  db.prepare(`SELECT type, scope, COUNT(*) AS n FROM engrams WHERE scope IN (${inList(scopes)}) GROUP BY type, scope ORDER BY scope, type`).all(...scopes)
    .map(r => [`${r.scope} ${r.type}`, r.n]),
)
const distBefore = dist(before)
const distAfter = dist(after)
const distTarget = dist(target)
console.log('engrams per scope × type (before → source after → target):')
for (const key of Object.keys(distBefore)) console.log(`  ${key}: ${distBefore[key]} → ${distAfter[key] ?? 0} → ${distTarget[key] ?? 0}`)
check(Object.keys(distAfter).length === 0, 'the source holds no engram of the tree any more')
check(JSON.stringify(distBefore) === JSON.stringify(distTarget), 'the target holds the tree as the source did, per scope and type')
const idsInAfter = ids.length === 0 ? 0 : count(after, `SELECT COUNT(*) AS n FROM engrams WHERE id IN (${inList(ids)})`, ...ids)
const idsInTarget = ids.length === 0 ? 0 : count(target, `SELECT COUNT(*) AS n FROM engrams WHERE id IN (${inList(ids)})`, ...ids)
check(idsInAfter === 0, `none of the ${ids.length} ids is left in the source (${idsInAfter})`)
check(idsInTarget === ids.length, `every id is in the target (${idsInTarget} of ${ids.length})`)

// rows exactly as stored: author, agent, timestamps, revision
const rowOf = (db, id) => db.prepare('SELECT id, type, scope, title, status, ingested_by, agent, created_at, updated_at, rev, length(content) AS len FROM engrams WHERE id = ?').get(id)
let unchanged = 0
for (const id of ids) if (JSON.stringify(rowOf(before, id)) === JSON.stringify(rowOf(target, id))) unchanged += 1
check(unchanged === ids.length, `every row arrived as stored — author, agent, timestamps, revision (${unchanged} of ${ids.length})`)

// --- what came along: entries, inner links, tags, subjects ---

const withIds = (db, sql) => (ids.length === 0 ? 0 : count(db, sql, ...ids))
const entriesBefore = withIds(before, `SELECT COUNT(*) AS n FROM entries WHERE engram_id IN (${inList(ids)})`)
const entriesTarget = withIds(target, `SELECT COUNT(*) AS n FROM entries WHERE engram_id IN (${inList(ids)})`)
check(entriesBefore === entriesTarget, `journal entries moved (${entriesBefore} → ${entriesTarget})`)
const innerSql = `SELECT COUNT(*) AS n FROM relations WHERE source_brain IS NULL AND target_brain IS NULL AND source_id IN (${inList(ids)}) AND target_id IN (${inList(ids)})`
const innerBefore = ids.length === 0 ? 0 : count(before, innerSql, ...ids, ...ids)
const innerTarget = ids.length === 0 ? 0 : count(target, innerSql, ...ids, ...ids)
check(innerBefore === innerTarget, `links inside the set moved (${innerBefore} → ${innerTarget})`)
const tagsBefore = withIds(before, `SELECT COUNT(*) AS n FROM engram_tags WHERE engram_id IN (${inList(ids)})`)
const tagsTarget = withIds(target, `SELECT COUNT(*) AS n FROM engram_tags WHERE engram_id IN (${inList(ids)})`)
check(tagsBefore === tagsTarget, `tag links moved (${tagsBefore} → ${tagsTarget})`)
const subjectsBefore = withIds(before, `SELECT COUNT(*) AS n FROM engram_subjects WHERE engram_id IN (${inList(ids)})`)
const subjectsTarget = withIds(target, `SELECT COUNT(*) AS n FROM engram_subjects WHERE engram_id IN (${inList(ids)})`)
check(subjectsBefore === subjectsTarget, `subject links moved (${subjectsBefore} → ${subjectsTarget})`)

// the registry rows the set needs are in the target: its scope objects, tags and
// subjects (ingested_by and agent are provenance labels, not rows — decision
// provenance-agent-field; a project move carries no agent.<id> or user.<id> scope)
const missing = (db, table, column, values) => values.filter(v => !db.prepare(`SELECT 1 FROM ${table} WHERE ${column} = ?`).get(v))
const neededProjects = [...new Set(setRows.map(r => r.scope.slice('project.'.length)))]
const neededTags = ids.length === 0 ? [] : before.prepare(`SELECT DISTINCT tag_id FROM engram_tags WHERE engram_id IN (${inList(ids)})`).all(...ids).map(r => r.tag_id)
const neededSubjects = ids.length === 0 ? [] : before.prepare(`SELECT DISTINCT subject_id FROM engram_subjects WHERE engram_id IN (${inList(ids)})`).all(...ids).map(r => r.subject_id)
for (const [table, column, values] of [['projects', 'id', neededProjects], ['tags', 'id', neededTags], ['subjects', 'id', neededSubjects]]) {
  const gone = missing(target, table, column, values)
  check(gone.length === 0, `the target has the ${table} the set needs (${values.length}${gone.length ? `; missing: ${gone.join(', ')}` : ''})`)
}
for (const id of neededProjects) {
  const parentBefore = before.prepare('SELECT parent_project FROM projects WHERE id = ?').get(id)?.parent_project ?? null
  const parentTarget = target.prepare('SELECT parent_project FROM projects WHERE id = ?').get(id)?.parent_project ?? null
  check(parentBefore === parentTarget || (parentBefore !== null && !neededProjects.includes(parentBefore) && parentTarget === parentBefore), `project ${id} keeps its parent in the target (${parentTarget ?? 'none'})`)
}

// --- what was dropped: links across the set's edge ---

const crossing = ids.length === 0 ? [] : before.prepare(`
  SELECT id, source_id, target_id FROM relations
  WHERE source_brain IS NULL AND target_brain IS NULL
    AND ((source_id IN (${inList(ids)}) AND target_id NOT IN (${inList(ids)})) OR (target_id IN (${inList(ids)}) AND source_id NOT IN (${inList(ids)})))
`).all(...ids, ...ids, ...ids, ...ids)
const crossingIds = crossing.map(r => r.id)
const crossingLeft = crossingIds.length === 0 ? 0 : count(after, `SELECT COUNT(*) AS n FROM relations WHERE id IN (${inList(crossingIds)})`, ...crossingIds)
const crossingThere = crossingIds.length === 0 ? 0 : count(target, `SELECT COUNT(*) AS n FROM relations WHERE id IN (${inList(crossingIds)})`, ...crossingIds)
check(crossingLeft === 0, `links to things that stayed behind are dropped in the source (${crossing.length} before, ${crossingLeft} left)`)
check(crossingThere === 0, `none of them was carried into the target (${crossingThere})`)
const otherSide = (r) => (ids.includes(r.source_id) ? r.target_id : r.source_id)
const otherScopes = {}
for (const r of crossing) {
  const scope = before.prepare('SELECT scope FROM engrams WHERE id = ?').get(otherSide(r))?.scope ?? '?'
  otherScopes[scope] = (otherScopes[scope] ?? 0) + 1
}
for (const [scope, n] of Object.entries(otherScopes).sort()) console.log(`     dropped towards ${scope}: ${n}`)

// --- the source after: the emptied projects archived and pointing at the target ---

const emptied = neededProjects
for (const id of emptied) {
  const row = after.prepare('SELECT status, metadata FROM projects WHERE id = ?').get(id)
  const meta = row?.metadata ? JSON.parse(row.metadata) : {}
  check(row?.status === 'archived' && meta.moved_to === targetBrain && /^\d{4}-\d{2}-\d{2}T/.test(meta.moved_at ?? ''),
    `project ${id} is archived in the source and points at the target (moved_to_name: ${meta.moved_to_name ?? 'none'}, moved_at: ${meta.moved_at ?? 'none'})`)
}
const stayed = tree.filter(id => !emptied.includes(id))
for (const id of stayed) {
  const row = after.prepare('SELECT status, metadata FROM projects WHERE id = ?').get(id)
  const was = before.prepare('SELECT status, metadata FROM projects WHERE id = ?').get(id)
  check(row?.status === was?.status && (row?.metadata ?? null) === (was?.metadata ?? null), `project ${id} had no engrams and stays as it was (${row?.status})`)
}

// --- the agent brains: references into the set name the target now, not the source ---

for (const { file, db } of agents) {
  const brain = brainIdOf(db)
  const stale = ids.length === 0 ? 0 : count(db, `SELECT COUNT(*) AS n FROM relations WHERE (source_brain = ? AND source_id IN (${inList(ids)})) OR (target_brain = ? AND target_id IN (${inList(ids)}))`, sourceBrain, ...ids, sourceBrain, ...ids)
  const pointed = ids.length === 0 ? 0 : count(db, `SELECT COUNT(*) AS n FROM relations WHERE (source_brain = ? AND source_id IN (${inList(ids)})) OR (target_brain = ? AND target_id IN (${inList(ids)}))`, targetBrain, ...ids, targetBrain, ...ids)
  check(stale === 0, `agent brain ${brain} (${basename(file)}): no reference into the set names the source brain any more (${stale}); ${pointed} name the target`)
  const other = count(db, 'SELECT COUNT(*) AS n FROM relations WHERE (source_brain = ? OR target_brain = ?)', sourceBrain, sourceBrain)
  console.log(`     ${other} reference(s) into the source brain outside the set stay as they are`)
}

// --- integrity of both brains ---

for (const [name, db] of [['source after', after], ['target', target]]) {
  const v = verify(db)
  check(v.ok === true, `${name}: the log replays to the state (${v.ok ? 'ok' : v.problem ?? 'differs'})`)
  const dangling = count(db, `
    SELECT COUNT(*) AS n FROM relations r
    WHERE (r.source_brain IS NULL AND NOT EXISTS (SELECT 1 FROM engrams e WHERE e.id = r.source_id))
       OR (r.target_brain IS NULL AND NOT EXISTS (SELECT 1 FROM engrams e WHERE e.id = r.target_id))
  `)
  check(dangling === 0, `${name}: no dangling link (${dangling})`)
  const noScope = count(db, `
    SELECT COUNT(*) AS n FROM engrams e
    WHERE (e.scope LIKE 'project.%' AND NOT EXISTS (SELECT 1 FROM projects p WHERE 'project.' || p.id = e.scope))
       OR (e.scope LIKE 'entity.%' AND NOT EXISTS (SELECT 1 FROM entities x WHERE 'entity.' || x.id = e.scope))
  `)
  check(noScope === 0, `${name}: every engram has its scope object (${noScope} without)`)
  const engrams = count(db, 'SELECT COUNT(*) AS n FROM engrams')
  const fts = count(db, 'SELECT COUNT(*) AS n FROM engrams_fts')
  check(engrams === fts, `${name}: the search index is complete (${fts} of ${engrams})`)
  const orphanEntries = count(db, 'SELECT COUNT(*) AS n FROM entries x WHERE NOT EXISTS (SELECT 1 FROM engrams e WHERE e.id = x.engram_id)')
  check(orphanEntries === 0, `${name}: no entry without its engram (${orphanEntries})`)
  const integrity = db.prepare('PRAGMA integrity_check').get()
  check(integrity?.integrity_check === 'ok', `${name}: integrity_check ${integrity?.integrity_check}`)
  const fk = db.prepare('PRAGMA foreign_key_check').all()
  check(fk.length === 0, `${name}: foreign_key_check (${fk.length} problem(s))`)
}

// --- totals ---

console.log('')
console.log(`source: ${count(before, 'SELECT COUNT(*) AS n FROM engrams')} engrams before → ${count(after, 'SELECT COUNT(*) AS n FROM engrams')} after; target: ${count(target, 'SELECT COUNT(*) AS n FROM engrams')} engrams`)
console.log(`moved: ${ids.length} engrams, ${entriesTarget} entries, ${innerTarget} links, ${tagsTarget} tag links, ${subjectsTarget} subject links; dropped: ${crossing.length} links`)

for (const db of [before, after, target, ...agents.map(a => a.db)]) db.close()
if (failures.length > 0) {
  console.log('')
  console.log(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
