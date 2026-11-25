import {
  hygieneSweep,
  inheritedRules,
  renderBrainStateMarkdown,
  renderRecallMarkdown,
  type ConflictSweepState,
  type EML,
  type EngramStatus,
  type EngramType,
  type HygieneReport,
  type Significance,
} from '@engramprotocol/core'
import { logHead } from './head'

// --- The reads whose cost grows with the brain ------------------------------------------
//
// A list, a recall, a dashboard, the statistics and the hygiene sweep read as
// much as the brain holds; better-sqlite3 runs them synchronously, so on the
// request thread each one holds up every other request of every brain for as
// long as it takes. They are written here as plain functions of a brain and
// their arguments, so the same code runs in a read worker (read-worker.ts, on
// its own read-only connection) and, when no worker can take it, on the request
// thread (read-pool.ts). The routes keep their parameter checks (server.ts);
// what arrives here is checked.
//
// An answer is the HTTP status and the body as JSON text: the worker
// serializes, the request thread only passes the text on.

export type Query = Record<string, string | undefined>
type OrderBy = 'created_at' | 'updated_at' | 'significance' | 'score'

/** What a read answers: the HTTP status and the JSON body, as text. */
export interface ReadAnswer {
  status: number
  body: string
}

const answer = (status: number, data: unknown): ReadAnswer => ({ status, body: JSON.stringify(data) })

const flag = (value: string | undefined): boolean | undefined => value === 'true' ? true : (value === 'false' ? false : undefined)

/** GET /list: the query checked by the route, review_due already read from it. */
function list(eml: EML, { q, reviewDue }: { q: Query, reviewDue: boolean | undefined }): ReadAnswer {
  const results = eml.engrams.query({
    type: q.type as EngramType | undefined,
    scope: q.scope,
    tag: q.tag,
    search: q.search,
    title: q.title,
    significance: q.significance as Significance | undefined,
    has_relations: flag(q.has_relations),
    limit: q.limit ? parseInt(q.limit) : 50,
    offset: q.offset ? parseInt(q.offset) : 0,
    order_by: (q.order_by as OrderBy) || 'updated_at',
    status: q.status as EngramStatus | undefined,
    assignee: q.assignee,
    review_due: reviewDue,
    subject: q.subject,
    stage: q.stage,
    binding: q.binding as 'task' | 'standing' | undefined,
    task_id: q.task_id,
    origin: q.origin,
    session_id: q.session_id,
    learning_state: q.state as 'collecting' | 'ripe' | 'unclear' | 'paused' | undefined,
    waiting_on: q.waiting_on,
    delegate: q.delegate,
  })
  // with_parent=true: a task names its parent task (parent_id), so a list shows plans without a call per task.
  // with_origin=true: a task names the task it was spun off from (origin_task_id, a derived_from link to a task),
  // so the cockpit draws task trees without a call per task.
  // with_latest_note=true: a task carries its newest journal note (latest_note {text, at}, or null), so the
  // cockpit shows where each task stands without a call per task.
  if (q.with_parent === 'true' || q.with_origin === 'true' || q.with_latest_note === 'true') {
    const linked = results.map((e) => {
      if (e.type !== 'task') return e
      const relations = q.with_parent === 'true' || q.with_origin === 'true' ? eml.engrams.relationsOf(e.id).filter((r) => r.source_id === e.id) : []
      const note = q.with_latest_note === 'true' ? eml.engrams.entries(e.id, ['note']).at(-1) : undefined
      return {
        ...e,
        ...(q.with_parent === 'true' ? { parent_id: relations.find((r) => r.relation === 'part_of')?.target_id ?? null } : {}),
        ...(q.with_origin === 'true' ? { origin_task_id: relations.find((r) => r.relation === 'derived_from' && r.target_engram?.type === 'task')?.target_id ?? null } : {}),
        ...(q.with_latest_note === 'true' ? { latest_note: note ? { text: note.text, at: note.at } : null } : {}),
      }
    })
    return answer(200, { count: linked.length, engrams: linked })
  }
  return answer(200, { count: results.length, engrams: results })
}

/** POST /recall: the whole brain, without a namespace filter. */
function recall(eml: EML, { query, min_significance, limit }: { query: string, min_significance?: Significance, limit?: number }): ReadAnswer {
  const results = eml.engrams.query({
    search: query,
    search_mode: 'or',
    significance: min_significance || undefined,
    limit: limit || 10,
    order_by: 'score',
    statuses: ['active', 'planned'], // live knowledge and open work
  })
  // Return ONLY the compact markdown (rendered in core). The full
  // engram array is intentionally NOT returned — callTool JSON-stringifies the whole
  // response, so returning full engrams would defeat the preview. Full body via eml_get.
  return answer(200, { query, engrams: results.length, markdown: renderRecallMarkdown(query, results) })
}

/** GET /brain-state?scope=: the compact dashboard markdown of any scope. */
function brainState(eml: EML, { scope }: { scope: string }): ReadAnswer {
  // Return the compact dashboard markdown, not the full structured state
  // (callTool stringifies the whole response → full engrams would blow the budget).
  const state = eml.engrams.buildBrainState(scope)
  // A project's dashboard shows its parents' rules too, marked inherited.
  state.rules = [...(state.rules ?? []), ...inheritedRules(eml, scope)]
  return answer(200, { scope, markdown: renderBrainStateMarkdown(state) })
}

/** GET /stats. */
function stats(eml: EML): ReadAnswer {
  const all = eml.engrams.query({ limit: 10000 })
  const types: Record<string, number> = {}
  const scopes: Record<string, number> = {}
  for (const c of all) {
    types[c.type] = (types[c.type] || 0) + 1
    scopes[c.scope] = (scopes[c.scope] || 0) + 1
  }
  return answer(200, {
    total_engrams: all.length,
    by_type: types,
    by_scope: scopes,
    agents: eml.agents.list().length,
    projects: eml.projects.list().length,
    users: eml.users.list().length,
  })
}

/** GET /project/:id/engrams: the query checked by the route, review_due already read from it. */
function projectEngrams(eml: EML, { id, q, reviewDue }: { id: string, q: Query, reviewDue: boolean | undefined }): ReadAnswer {
  if (!eml.projects.get(id)) return answer(404, { error: `project "${id}" not found` })
  const engrams = eml.engrams.query({
    scope: `project.${id}`,
    type: q.type as EngramType | undefined,
    status: q.status as EngramStatus | undefined,
    significance: q.significance as Significance | undefined,
    title: q.title,
    tag: q.tag,
    has_relations: flag(q.has_relations),
    limit: q.limit ? parseInt(q.limit) : 50,
    offset: q.offset ? parseInt(q.offset) : 0,
    order_by: (q.order_by as OrderBy) || 'updated_at',
    assignee: q.assignee,
    review_due: reviewDue,
    subject: q.subject,
    stage: q.stage,
  })
  return answer(200, { count: engrams.length, engrams })
}

/** GET /project/:id/relations. */
function projectRelations(eml: EML, { id }: { id: string }): ReadAnswer {
  if (!eml.projects.get(id)) return answer(404, { error: `project "${id}" not found` })
  const relations = eml.engrams.relationsInScope(`project.${id}`)
  return answer(200, { count: relations.length, relations })
}

/** What one hygiene sweep gives the report store (hygiene-reports.ts): the report, and what the next sweep starts from. */
export interface HygieneSweepAnswer {
  /** The log head the sweep read before it started: a head that differs later means the brain changed since. */
  seq: number
  /** When the sweep started. */
  computed_at: string
  report: HygieneReport
  conflicts: ConflictSweepState
}

/** The hygiene sweep (core hygiene.ts): every check; the conflict scan over the whole brain, or — with `previous` — over what changed since. */
function hygiene(eml: EML, { previous }: { previous?: ConflictSweepState }, db: Parameters<typeof logHead>[0]): ReadAnswer {
  const seq = logHead(db)
  const now = new Date(eml.now())
  const swept = hygieneSweep(eml, { now, ...(previous ? { previous } : {}) })
  const body: HygieneSweepAnswer = { seq, computed_at: now.toISOString(), report: swept.report, conflicts: swept.conflicts }
  return answer(200, body)
}

const READS = {
  list,
  recall,
  'brain-state': brainState,
  stats,
  'project-engrams': projectEngrams,
  'project-relations': projectRelations,
  hygiene,
} as const

export type ReadKind = keyof typeof READS
export type ReadArgs<K extends ReadKind> = Parameters<(typeof READS)[K]>[1]

/** Run one read on `eml`, a brain open on `db`. Throws what the read throws (a core validation message reads as a 400 in the route). */
export function runRead<K extends ReadKind>(eml: EML, db: Parameters<typeof logHead>[0], kind: K, args: ReadArgs<K>): ReadAnswer {
  const read = READS[kind] as ((eml: EML, args: ReadArgs<K>, db: Parameters<typeof logHead>[0]) => ReadAnswer) | undefined
  if (!read) throw new Error(`unknown read: ${String(kind)}`)
  return read(eml, args, db)
}
