import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  EML,
  extractSalientTerms,
  termCoverage,
  CONFLICT_COVERAGE_THRESHOLD,
  CONFLICT_MAX,
  recordedDismissal,
} from '../src'
import {
  validDecision, validLog, validTask, writes,
} from './fixtures'

// v0.10.9 write-time conflict guardrail. Asserts the term-coverage gate at the
// calibrated threshold (≈0.5): a vocabulary-overlapping re-write FIRES (candidate
// surfaced), a paraphrase without shared vocabulary stays SILENT (empty field).
// Plus the structural exclusions (self / judged pairs / same-task thread /
// log+event) and the pure extraction + coverage helpers.
// conflict-detection (phase 1, 2026-11-19): a same-title pair WITHOUT an edge is
// a candidate (flagged lineage, no longer excluded), and any typed edge between
// the pair is a prior verdict (excluded). Stable across FTS-impl changes —
// asserts coverage, not opaque BM25 numbers. See docs/specs/v0.10.9-PROPOSAL.md.

describe('conflict guardrail — recorded dismissal', () => {
  it('writes a distinct_from as the marked related_to, the reason behind the fixed prefix', () => {
    expect(recordedDismissal({ source_id: 'a', target_id: 'b', relation: 'distinct_from', explanation: ' different topics ', metadata: { k: 1 } })).toEqual({
      source_id: 'a', target_id: 'b', relation: 'related_to',
      explanation: 'conflict check: judged distinct — different topics',
      metadata: { k: 1, conflict_check: 'distinct' },
    })
  })

  it('needs the reason, and leaves every other payload as it is', () => {
    expect(() => recordedDismissal({ source_id: 'a', target_id: 'b', relation: 'distinct_from' })).toThrow('distinct_from needs an explanation')
    expect(() => recordedDismissal({ source_id: 'a', target_id: 'b', relation: 'distinct_from', explanation: '  ' })).toThrow('distinct_from needs an explanation')
    const other = { source_id: 'a', target_id: 'b', relation: 'related_to' }
    expect(recordedDismissal(other)).toBe(other)
    expect(recordedDismissal(null)).toBe(null)
  })
})

describe('conflict guardrail — pure helpers', () => {
  it('extractSalientTerms: title tokens (kebab-split, unfiltered) + content terms len≥4, stopword-stripped', () => {
    const terms = extractSalientTerms('brand-and-domain', 'Engram Protocol is the naming with a plan')
    // title tokens kept verbatim (incl. short "and")
    expect(terms).toContain('brand')
    expect(terms).toContain('and')
    expect(terms).toContain('domain')
    // content terms len≥4, not stopwords
    expect(terms).toContain('engram')
    expect(terms).toContain('protocol')
    expect(terms).toContain('naming')
    // dropped: len<4 ("is", "the", "a") and the stopword "with"
    expect(terms).not.toContain('is')
    expect(terms).not.toContain('the')
    expect(terms).not.toContain('with')
    // deduped
    expect(new Set(terms).size).toBe(terms.length)
  })

  it('termCoverage: fraction of salient terms present in the candidate', () => {
    const salient = ['alpha', 'beta', 'gamma', 'delta']
    // 2/4 = exactly the threshold
    expect(termCoverage(salient, 'alpha beta only')).toBe(0.5)
    // 1/4 below
    expect(termCoverage(salient, 'alpha only')).toBe(0.25)
    // all present
    expect(termCoverage(salient, 'delta gamma beta alpha extra')).toBe(1)
    // empty salient set → 0 (cannot judge → never fires)
    expect(termCoverage([], 'whatever')).toBe(0)
  })

  it('threshold is the documented ≈0.5 (a write coupling at exactly 0.5 fires, not drops)', () => {
    expect(CONFLICT_COVERAGE_THRESHOLD).toBe(0.5)
  })
})

describe('conflict guardrail — store() integration', () => {
  let eml: EML

  beforeEach(() => {
    eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    writes(eml).projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => {
    eml.close()
  })

  it('FIRES: a different-title re-decide that repeats the vocabulary surfaces the candidate (coverage ≥ 0.5)', () => {
    const seed = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
    }))

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-rename',
      content: 'Engram Protocol brand naming and domain choice canonical.',
    }))

    expect(res.potential_conflicts).toBeDefined()
    const ids = res.potential_conflicts!.map(c => c.id)
    expect(ids).toContain(seed.id)
    const hit = res.potential_conflicts!.find(c => c.id === seed.id)!
    expect(hit.coverage).toBeGreaterThanOrEqual(CONFLICT_COVERAGE_THRESHOLD)
    expect(hit.overlap).toBe('fts')
    expect(hit.type).toBe('decision')
  })

  it('SILENT: a paraphrase without shared vocabulary stays empty (the accepted FTS/coverage miss)', () => {
    writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
    }))

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'product-public-identity',
      content: 'What we call the offering publicly, its market label and customer-facing handle.',
    }))

    expect(res.potential_conflicts).toBeUndefined()
  })

  it('SILENT: a clean novel write in an empty scope surfaces nothing', () => {
    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'pick-ci-runner',
      content: 'Use GitHub Actions for continuous integration pipelines on pushes.',
    }))
    expect(res.potential_conflicts).toBeUndefined()
  })

  it('LINEAGE: a same-title write without an edge is a candidate, flagged lineage (the concurrent-writer case)', () => {
    const seed = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'persistence-sqlite',
      content: 'We use SQLite for persistence — single-file local database, deterministic.',
    }))

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'persistence-sqlite', // SAME title, no edge between the pair
      content: 'SQLite persistence single-file local database deterministic choice.',
    }))

    expect(res.potential_conflicts).toBeDefined()
    const hit = res.potential_conflicts!.find(c => c.id === seed.id)
    expect(hit).toBeDefined()
    expect(hit!.lineage).toBe(true)
  })

  it('EXCLUDES a pair with an edge: a wikilink-drawn related_to is a prior verdict about the pair', () => {
    writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
    }))

    // The [[wikilink]] materializes a related_to edge to the seed at write time,
    // so the seed is no longer a candidate of this write.
    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-rename',
      content: 'Engram Protocol brand naming and domain choice canonical — see [[brand-and-domain]].',
    }))

    expect(res.potential_conflicts).toBeUndefined()
  })

  it('EXCLUDES the same-task thread: task-bound siblings with overlapping vocabulary are not flagged; same-title inside the task still is', () => {
    const task = writes(eml).store(validTask({
      scope: 'project.eml',
      title: 'conflict-detection',
      status: 'active',
      content: 'the conflict detection work thread',
    }))
    const first = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'dec-conflict-plan',
      task_id: task.id,
      properties: { binding: 'task' },
      content: 'conflict detection sweep threshold coverage decision one.',
    }))

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'dec-conflict-plan-two',
      task_id: task.id,
      properties: { binding: 'task' },
      content: 'conflict detection sweep threshold coverage decision two.',
    }))

    // The sibling in the same task and the task itself are the thread, not conflicts.
    expect(res.potential_conflicts).toBeUndefined()

    // Same title inside the task is the duplicate marker and stays, flagged lineage.
    const lineage = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'dec-conflict-plan',
      task_id: task.id,
      properties: { binding: 'task' },
      content: 'conflict detection sweep threshold coverage decision three.',
    }))
    const hit = lineage.potential_conflicts!.find(c => c.id === first.id)
    expect(hit).toBeDefined()
    expect(hit!.lineage).toBe(true)
  })

  it('EXCLUDES log/event candidates: a heavily-overlapping log is never a supersede/merge target', () => {
    writes(eml).store(validLog({
      scope: 'project.eml',
      title: 'session-brand-work',
      content: 'Brand name Engram Protocol, domain engramprotocol.io, canonical naming choice discussed.',
    }))

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-rename',
      content: 'Engram Protocol brand naming and domain choice canonical.',
    }))

    expect(res.potential_conflicts).toBeUndefined()
  })

  it('CAPS at N=3 survivors even when more candidates clear the gate', () => {
    for (let i = 0; i < 5; i++) {
      writes(eml).store(validDecision({
        scope: 'project.eml',
        title: `brand-variant-${i}`,
        content: 'Brand naming Engram Protocol domain canonical choice variant.',
      }))
    }

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-rename',
      content: 'Brand naming Engram Protocol domain canonical choice.',
    }))

    expect(res.potential_conflicts).toBeDefined()
    expect(res.potential_conflicts!.length).toBeLessThanOrEqual(3)
  })

  it('CAPS by coverage, not retrieval order: the highest-coverage near-duplicate always survives the N=3 cap', () => {
    // 4 partial-overlap candidates that clear the gate but miss two salient terms
    // ('rebrand', 'decision') → coverage ~0.67. They share enough vocabulary to be
    // retrieved alongside the true duplicate.
    for (let i = 0; i < 4; i++) {
      writes(eml).store(validDecision({
        scope: 'project.eml',
        title: `infra-note-${i}`,
        content: 'Brand naming Engram Protocol domain canonical filler.',
      }))
    }
    // The true near-duplicate: covers every salient term except the title-only
    // 'rename' → strictly highest coverage. If the cap trimmed in retrieval order
    // instead of coverage order, this could be dropped past rank 3.
    const dup = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand naming Engram Protocol domain canonical rebrand decision.',
    }))

    const res = writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-rename',
      content: 'Brand naming Engram Protocol domain canonical rebrand decision.',
    }))

    expect(res.potential_conflicts).toBeDefined()
    expect(res.potential_conflicts!.length).toBe(CONFLICT_MAX)
    // The highest-coverage hit (the true duplicate) must be kept and ranked first —
    // never trimmed because retrieval order placed it past the cap.
    expect(res.potential_conflicts!.map(c => c.id)).toContain(dup.id)
    expect(res.potential_conflicts![0].id).toBe(dup.id)
    // Survivors arrive coverage-descending.
    const covs = res.potential_conflicts!.map(c => c.coverage)
    expect([...covs]).toEqual([...covs].sort((a, b) => b - a))
  })

  it('does not scan log/event WRITES (no potential_conflicts field for append-only types)', () => {
    writes(eml).store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name Engram Protocol domain canonical naming choice.',
    }))
    const res = writes(eml).store(validLog({
      scope: 'project.eml',
      title: 'session-recap',
      content: 'Brand Engram Protocol domain canonical naming choice recap.',
    }))
    expect(res.potential_conflicts).toBeUndefined()
  })
})
