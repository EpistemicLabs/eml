import type { Engram, ConflictCandidate } from '../types'
import {
  CONFLICT_CANDIDATE_LIMIT, CONFLICT_COVERAGE_THRESHOLD, CONFLICT_MAX, CONFLICT_MIN_SHARED_TERMS,
  EVENT_DUPLICATE_WINDOW_MS, extractSalientTerms, termCoverage,
} from '../engrams'
import { boundTaskOf } from './task-binding'
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
 *   contradicts, or a dismissal marked "conflict check: judged distinct").
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

  // A typed edge between the pair is a verdict that was already reached about
  // it — any verb, either direction.
  const linked = new Set((ctx.db.prepare(`
    SELECT target_id AS id FROM relations WHERE source_id = ?
    UNION SELECT source_id FROM relations WHERE target_id = ?
  `).all(engram.id, engram.id) as Array<{ id: string }>).map(r => r.id))

  return filterConflictCandidates({ engram, linked, boundTask: id => boundTaskOf(ctx, id)?.id }, candidates)
}

/** What the candidate filter needs: the engram, the ids it already has a verdict edge to, and the task binding. */
export interface ConflictFilter {
  engram: Engram
  /** Ids the engram already carries a typed relation to (a prior verdict about the pair). */
  linked: ReadonlySet<string>
  /** The task an id is bound to (derived_from/refines to a task), if any. */
  boundTask: (id: string) => string | undefined
}

/**
 * The shared candidate filter (write-time and the batch sweep): drop self,
 * the judged pairs, the same-task thread and the type pairings, apply the
 * coverage gate, cap by coverage. A same-title candidate without an edge
 * survives, flagged lineage.
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
  const survivors: ConflictCandidate[] = []
  for (const c of candidates) {
    if (c.id === engram.id) continue                                   // self
    if (f.linked.has(c.id)) continue                                   // a verdict edge exists between the pair
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
