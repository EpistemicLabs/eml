import type { Engram, ConflictCandidate } from '../types'
import {
  CONFLICT_CANDIDATE_LIMIT, CONFLICT_COVERAGE_THRESHOLD, CONFLICT_MAX, CONFLICT_MIN_SHARED_TERMS,
  EVENT_DUPLICATE_WINDOW_MS, extractSalientTerms, termCoverage,
} from '../engrams'
import { boundTaskOf } from './task-binding'
import { CommandError } from '../commands/types'
import type { WriteContext } from './context'

/**
 * v0.10.9: surface active same-scope engrams the just-written engram may
 * duplicate/contradict. Deterministic, FTS-based, advisory (the agent judges).
 *
 * Order is load-bearing: over-fetch FTS candidates (BM25-ranked), THEN exclude
 * self / judged pairs / the same-task thread / log+event, THEN drop below the
 * coverage gate, THEN cap at N=3. Filtering happens BEFORE the cap — never
 * SQL limit:3 then post-filter, which would let a real conflict at FTS-rank 4+
 * go unseen (the C0 bug class).
 *
 * conflict-detection (phase 1, 2026-11-19): two changes to the candidate set —
 * - a same-title candidate WITHOUT any relation between the pair is no longer
 *   excluded: two concurrent writers under one title is the duplicate case the
 *   old exclusion hid. It stays a candidate, flagged lineage (check the link;
 *   record a dismissal as the marked related_to edge).
 * - a pair that already carries ANY typed relation is excluded: an edge is a
 *   prior verdict about the pair (a lineage link, a see-also, a supports, a
 *   contradicts, or a recorded dismissal).
 * - a same-title series is one thread once its members are chained: each
 *   member links to the previous one, so a pair further apart has no edge of
 *   its own and is excluded through the chain.
 *
 * The filter (filterConflictCandidates) is shared with the batch hygiene
 * sweep (decision batch-scan-reuses-the-detector): same filters, same gate,
 * same cap — only the retrieval and the relation lookups differ per surface.
 */

export function findPotentialConflicts(ctx: WriteContext, engram: Engram): ConflictCandidate[] {
  const salient = extractSalientTerms(engram.title, engram.content)
  if (salient.length === 0) return []

  // search_mode 'or' = fuzzy recall path (NOT list's implicit AND); order_by
  // 'score' = BM25 ranking. Generous limit → over-fetch; the typed+scoped
  // candidate set is tiny, so this stays cheap.
  // v0.19: planned tasks are open work too — a new task is compared with them.
  const candidates = ctx.store.query({
    search: salient.join(' '),
    search_mode: 'or',
    scope: engram.scope,
    statuses: ['active', 'planned'],
    order_by: 'score',
    limit: CONFLICT_CANDIDATE_LIMIT,
    now: ctx.stamp.at,
  })

  // A typed edge between a pair is a verdict that was already reached about
  // it — any verb, either direction.
  const edges = ctx.db.prepare(`
    SELECT target_id AS id FROM relations WHERE source_id = ?
    UNION SELECT source_id FROM relations WHERE target_id = ?
  `)
  const linkedOf = (id: string) => new Set((edges.all(id, id) as Array<{ id: string }>).map(r => r.id))

  return filterConflictCandidates({ engram, linkedOf, boundTask: id => boundTaskOf(ctx, id)?.id }, candidates)
}

/** What the candidate filter needs: the engram, the verdict edges and the task binding. */
export interface ConflictFilter {
  engram: Engram
  /** Ids an engram already carries a typed relation to (a prior verdict about the pair). */
  linkedOf: (id: string) => ReadonlySet<string>
  /** The task an id is bound to (derived_from/refines to a task), if any. */
  boundTask: (id: string) => string | undefined
}

/**
 * The shared candidate filter (write-time and the batch sweep): drop self,
 * the judged pairs, the same-task thread and the type pairings, apply the
 * coverage gate, cap by coverage. A same-title candidate without an edge
 * survives, flagged lineage — unless a chain of its series leads to it.
 */
export function filterConflictCandidates(f: ConflictFilter, candidates: Engram[]): ConflictCandidate[] {
  const { engram } = f
  const salient = extractSalientTerms(engram.title, engram.content)
  if (salient.length === 0) return []

  const props = (engram.properties ?? {}) as Record<string, unknown>
  // Work inside one task is a thread — expected overlap, excluded from the
  // candidates; a same-TITLE pair inside the task is the duplicate marker and
  // stays (two parallel sessions writing under one title in one task).
  const ownTask = f.boundTask(engram.id)
  const linked = f.linkedOf(engram.id)
  const series = seriesChain(f, candidates)
  const survivors: ConflictCandidate[] = []
  for (const c of candidates) {
    if (c.id === engram.id) continue                                   // self
    if (linked.has(c.id)) continue                                     // a verdict edge exists between the pair
    if (series.has(c.id)) continue                                     // the same series, reached through its chain
    if (c.status === 'planned' && c.type !== 'task') continue          // only tasks are open while planned
    const sameTitle = c.title !== null && c.title === engram.title
    if (!sameTitle && ownTask !== undefined && f.boundTask(c.id) === ownTask) continue // the same-task thread
    if (c.type === 'log' || c.type === 'learning') continue            // never a supersede/merge target
    if ((c.type === 'event') !== (engram.type === 'event')) continue   // events only against events
    if (engram.type === 'event') {
      const cp = (c.properties ?? {}) as Record<string, unknown>
      const gap = Math.abs(Date.parse(String(cp.occurred_at)) - Date.parse(String(props.occurred_at)))
      if (cp.change_type !== props.change_type || !(gap <= EVENT_DUPLICATE_WINDOW_MS)) continue
    }
    const coverage = termCoverage(salient, `${c.title ?? ''} ${c.content}`)
    if (coverage < CONFLICT_COVERAGE_THRESHOLD) continue               // the load-bearing gate
    if (Math.round(coverage * salient.length) < CONFLICT_MIN_SHARED_TERMS) continue  // a short write needs real overlap
    survivors.push({
      id: c.id,
      type: c.type,
      title: c.title,
      gist: c.content.slice(0, 200),
      overlap: 'fts',
      coverage: Math.round(coverage * 100) / 100,
      lineage: sameTitle ? true : undefined, // possible thread — check for a link, else record the dismissal
    })
  }

  // Cap by COVERAGE, not BM25 order. BM25 ranks retrieval, but coverage is the
  // precision/escalation metric (the banner escalates on the max-coverage survivor).
  // If >N candidates clear the gate, trimming in BM25 order could drop a
  // near-identical (high-coverage) hit that BM25 ranked 4+, silently suppressing
  // the escalation exactly when it matters. Sort coverage-desc, then cap the tail.
  survivors.sort((a, b) => b.coverage - a.coverage)
  return survivors.slice(0, CONFLICT_MAX)
}

/**
 * The members of the engram's series that a chain of edges leads to. A series
 * is the candidates of the engram's type under its title; the walk follows
 * edges from member to member only, so a task both are bound to is no bridge
 * (a same-title pair inside one task stays the duplicate marker).
 */
function seriesChain(f: ConflictFilter, candidates: Engram[]): ReadonlySet<string> {
  const { engram } = f
  const reached = new Set<string>()
  if (engram.title === null) return reached
  const members = new Set(candidates.filter(c => c.id !== engram.id && c.type === engram.type && c.title === engram.title).map(c => c.id))
  if (members.size === 0) return reached
  const queue = [engram.id]
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const next of f.linkedOf(id)) {
      if (!members.has(next) || reached.has(next)) continue
      reached.add(next)
      queue.push(next)
    }
  }
  return reached
}

/**
 * A dismissed candidate pair: compared and judged distinct. Schema 21 has no
 * verb of its own for it, so a relation written as distinct_from is recorded
 * as a related_to edge that carries the marker — the explanation in one fixed
 * form and metadata.conflict_check. The server writes the marker, not the
 * agent, so every recorded dismissal can be told from a see-also.
 */
export const DISMISSAL_VERB = 'distinct_from'
export const DISMISSAL_EXPLANATION_PREFIX = 'conflict check: judged distinct — '

/** A relation.create payload as it is recorded: a distinct_from becomes the marked related_to; any other payload passes unchanged. */
export function recordedDismissal(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input
  const o = input as Record<string, unknown>
  if (o.relation !== DISMISSAL_VERB) return input
  const reason = typeof o.explanation === 'string' ? o.explanation.trim() : ''
  if (reason === '') throw new CommandError('INVALID', 'distinct_from needs an explanation: why the two are distinct')
  const metadata = o.metadata !== null && typeof o.metadata === 'object' && !Array.isArray(o.metadata) ? o.metadata : {}
  return {
    ...o,
    relation: 'related_to',
    explanation: DISMISSAL_EXPLANATION_PREFIX + reason,
    metadata: { ...metadata, conflict_check: 'distinct' },
  }
}
