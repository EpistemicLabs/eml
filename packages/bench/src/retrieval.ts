import fs from 'fs'
import path from 'path'
import { FIXTURE_DIR, type Brain } from './fixture'
import type { Api } from './sut'

// --- Stage 1: retrieval -------------------------------------------------------------
//
// Deterministic, no model. Each question's probe is sent to the REST route the
// matching MCP tool calls (recall → POST /recall, show → GET /brain-state,
// boot → POST /boot), and the markdown the agent would read is scored: in which
// order do the engram ids appear? Recall and show print ids; the boot prints
// titles, so boot questions are scored by title.

export const RECALL_K = 5

export interface Question {
  id: string
  category: string
  retrieval: { tool: 'recall'; query: string } | { tool: 'show'; scope: string } | { tool: 'boot' } | null
  expect: string[]
  stale?: string[]
  absent?: string[]
  agent: { question: string; reference: string; stale_claims: string[] } | null
}

export function readQuestions(): Question[] {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'questions.json'), 'utf8')).questions
}

export interface RetrievalResult {
  id: string
  category: string
  tool: string
  /** 1-based rank of the best expected engram; null = not surfaced */
  rank: number | null
  /** expected engrams that surfaced / all expected */
  found: number
  expected: number
  /** a stale engram surfaced above the best current one (or at all, for show/boot) */
  stale_hit: boolean
  /** the question names stale engrams at all */
  stale_checked: boolean
  /** an engram that must not appear did appear */
  absent_hit: boolean
  chars: number
  ms: number
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Engram ids in the order they first appear in the markdown. */
export function idsInOrder(markdown: string): string[] {
  const seen: string[] = []
  for (const m of markdown.match(UUID) ?? []) if (!seen.includes(m)) seen.push(m)
  return seen
}

/** dumpDir: where to keep each probe's markdown (<question id>.md), for reading why a question moved. */
export async function runRetrieval(api: Api, brain: Brain, questions: Question[], dumpDir?: string): Promise<RetrievalResult[]> {
  if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true })
  const out: RetrievalResult[] = []
  for (const q of questions) {
    if (!q.retrieval) continue
    const t0 = performance.now()
    let markdown: string
    if (q.retrieval.tool === 'recall') {
      markdown = (await api.call('POST', '/recall', { query: q.retrieval.query })).markdown
    } else if (q.retrieval.tool === 'show') {
      markdown = (await api.call('GET', `/brain-state?scope=${encodeURIComponent(q.retrieval.scope)}`)).markdown
    } else {
      markdown = (await api.call('POST', '/boot', { agent: brain.agent })).markdown
    }
    const ms = performance.now() - t0
    if (dumpDir) fs.writeFileSync(path.join(dumpDir, `${q.id}.md`), markdown)
    out.push({ ...score(q, markdown, brain), id: q.id, category: q.category, tool: q.retrieval.tool, chars: markdown.length, ms })
  }
  return out
}

export function score(q: Question, markdown: string, brain: Brain) {
  // Position of each fixture key in the output (1-based), by id or — for the boot — by title.
  const byTitle = q.retrieval?.tool === 'boot'
  const order = byTitle ? [] : idsInOrder(markdown)
  const pos = (key: string): number | null => {
    if (byTitle) {
      const i = markdown.indexOf(brain.titles[key])
      return i < 0 ? null : i + 1
    }
    const i = order.indexOf(brain.ids[key])
    return i < 0 ? null : i + 1
  }
  const expectedPos = q.expect.map(pos).filter((p): p is number => p !== null)
  const best = expectedPos.length ? Math.min(...expectedPos) : null
  const ordered = q.retrieval?.tool === 'recall'
  const stale_hit = (q.stale ?? []).some(k => {
    const p = pos(k)
    if (p === null) return false
    return ordered ? best === null || p < best : true
  })
  const absent_hit = (q.absent ?? []).some(k => pos(k) !== null)
  // Rank only means something for an ordered result list; for show/boot an
  // expected engram is either there (rank 1) or not.
  const rank = best === null ? null : ordered ? best : 1
  return { rank, found: expectedPos.length, expected: q.expect.length, stale_hit, stale_checked: (q.stale ?? []).length > 0, absent_hit }
}

export interface RetrievalSummary {
  questions: number
  recall_at_k: number
  mrr: number
  coverage: number
  stale_rate: number
  absent_rate: number
  avg_chars: Record<string, number>
  avg_ms: number
  by_category: Record<string, { questions: number; recall_at_k: number; mrr: number }>
}

export function summarize(results: RetrievalResult[]): RetrievalSummary {
  const n = results.length
  const hitAtK = (r: RetrievalResult) => (r.rank !== null && r.rank <= RECALL_K ? 1 : 0)
  const rr = (r: RetrievalResult) => (r.rank === null ? 0 : 1 / r.rank)
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)
  const withStale = results.filter(r => r.stale_checked)
  const by_category: RetrievalSummary['by_category'] = {}
  for (const cat of [...new Set(results.map(r => r.category))].sort()) {
    const rs = results.filter(r => r.category === cat)
    by_category[cat] = { questions: rs.length, recall_at_k: round(mean(rs.map(hitAtK))), mrr: round(mean(rs.map(rr))) }
  }
  const avg_chars: Record<string, number> = {}
  for (const tool of [...new Set(results.map(r => r.tool))].sort()) {
    avg_chars[tool] = Math.round(mean(results.filter(r => r.tool === tool).map(r => r.chars)))
  }
  return {
    questions: n,
    recall_at_k: round(mean(results.map(hitAtK))),
    mrr: round(mean(results.map(rr))),
    coverage: round(mean(results.map(r => (r.expected ? r.found / r.expected : 1)))),
    stale_rate: round(mean(withStale.map(r => (r.stale_hit ? 1 : 0)))),
    absent_rate: round(mean(results.map(r => (r.absent_hit ? 1 : 0)))),
    avg_chars,
    avg_ms: round(mean(results.map(r => r.ms)), 1),
    by_category,
  }
}

function round(x: number, digits = 3): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}
