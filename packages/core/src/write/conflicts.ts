import type { Engram, ConflictCandidate } from '../types'
import {
  CONFLICT_CANDIDATE_LIMIT, CONFLICT_COVERAGE_THRESHOLD, CONFLICT_MAX, CONFLICT_MIN_SHARED_TERMS,
  EVENT_DUPLICATE_WINDOW_MS, extractSalientTerms, termCoverage,
} from '../engrams'
import type { WriteContext } from './context'

/**
 * v0.10.9: surface active same-scope engrams the just-written engram may
 * duplicate/contradict. Deterministic, FTS-based, advisory (the agent judges).
 *
 * Order is load-bearing: over-fetch FTS candidates (BM25-ranked), THEN exclude
 * self / same-title / log+event, THEN drop below the coverage gate, THEN cap
 * at N=3. Filtering happens BEFORE the cap — never SQL limit:3 then post-filter,
 * which would let a real conflict at FTS-rank 4+ go unseen (the C0 bug class).
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

  const props = (engram.properties ?? {}) as Record<string, unknown>
  // v0.19: what the write is deliberately tied to (its parent, the task it is
  // bound to, what it supersedes) is not a conflict of it.
  const linked = new Set((ctx.db.prepare(`
    SELECT target_id AS id FROM relations WHERE source_id = ? AND relation IN ('part_of', 'derived_from', 'refines', 'supersedes')
    UNION SELECT source_id FROM relations WHERE target_id = ? AND relation IN ('part_of', 'derived_from', 'refines', 'supersedes')
  `).all(engram.id, engram.id) as Array<{ id: string }>).map(r => r.id))
  const survivors: ConflictCandidate[] = []
  for (const c of candidates) {
    if (c.id === engram.id) continue                                   // self
    if (linked.has(c.id)) continue                                     // tied to the write on purpose
    if (c.status === 'planned' && c.type !== 'task') continue          // only tasks are open while planned
    if (c.title !== null && c.title === engram.title) continue   // same-title (thread, not conflict)
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
