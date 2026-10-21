import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  EML,
  extractSalientTerms,
  termCoverage,
  CONFLICT_COVERAGE_THRESHOLD,
  CONFLICT_MAX,
} from '../src'
import { validDecision, validLog } from './fixtures'

// v0.10.9 write-time conflict guardrail. Asserts the term-coverage gate at the
// calibrated threshold (≈0.5): a vocabulary-overlapping re-write FIRES (candidate
// surfaced), a paraphrase without shared vocabulary stays SILENT (empty field).
// Plus the structural exclusions (self / same-title / log+event) and the pure
// extraction + coverage helpers. Stable across FTS-impl changes — asserts coverage,
// not opaque BM25 numbers. See docs/specs/v0.10.9-PROPOSAL.md.

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
    eml.projects.create({ id: 'eml', name: 'EML' })
  })

  afterEach(() => {
    eml.close()
  })

  it('FIRES: a different-title re-decide that repeats the vocabulary surfaces the candidate (coverage ≥ 0.5)', () => {
    const seed = eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
    }))

    const res = eml.engrams.store(validDecision({
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
    eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name is Engram Protocol, domain engramprotocol.io is the canonical naming choice.',
    }))

    const res = eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'product-public-identity',
      content: 'What we call the offering publicly, its market label and customer-facing handle.',
    }))

    expect(res.potential_conflicts).toBeUndefined()
  })

  it('SILENT: a clean novel write in an empty scope surfaces nothing', () => {
    const res = eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'pick-ci-runner',
      content: 'Use GitHub Actions for continuous integration pipelines on pushes.',
    }))
    expect(res.potential_conflicts).toBeUndefined()
  })

  it('EXCLUDES same-title: an intentional thread/supersede lineage is never flagged as a conflict', () => {
    eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'persistence-sqlite',
      content: 'We use SQLite for persistence — single-file local database, deterministic.',
    }))

    const res = eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'persistence-sqlite', // SAME title — heavy overlap but a deliberate lineage
      content: 'SQLite persistence single-file local database deterministic choice.',
    }))

    expect(res.potential_conflicts).toBeUndefined()
  })

  it('EXCLUDES log/event candidates: a heavily-overlapping log is never a supersede/merge target', () => {
    eml.engrams.store(validLog({
      scope: 'project.eml',
      title: 'session-brand-work',
      content: 'Brand name Engram Protocol, domain engramprotocol.io, canonical naming choice discussed.',
    }))

    const res = eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'brand-rename',
      content: 'Engram Protocol brand naming and domain choice canonical.',
    }))

    expect(res.potential_conflicts).toBeUndefined()
  })

  it('CAPS at N=3 survivors even when more candidates clear the gate', () => {
    for (let i = 0; i < 5; i++) {
      eml.engrams.store(validDecision({
        scope: 'project.eml',
        title: `brand-variant-${i}`,
        content: 'Brand naming Engram Protocol domain canonical choice variant.',
      }))
    }

    const res = eml.engrams.store(validDecision({
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
      eml.engrams.store(validDecision({
        scope: 'project.eml',
        title: `infra-note-${i}`,
        content: 'Brand naming Engram Protocol domain canonical filler.',
      }))
    }
    // The true near-duplicate: covers every salient term except the title-only
    // 'rename' → strictly highest coverage. If the cap trimmed in retrieval order
    // instead of coverage order, this could be dropped past rank 3.
    const dup = eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand naming Engram Protocol domain canonical rebrand decision.',
    }))

    const res = eml.engrams.store(validDecision({
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
    eml.engrams.store(validDecision({
      scope: 'project.eml',
      title: 'brand-and-domain',
      content: 'Brand name Engram Protocol domain canonical naming choice.',
    }))
    const res = eml.engrams.store(validLog({
      scope: 'project.eml',
      title: 'session-recap',
      content: 'Brand Engram Protocol domain canonical naming choice recap.',
    }))
    expect(res.potential_conflicts).toBeUndefined()
  })
})
