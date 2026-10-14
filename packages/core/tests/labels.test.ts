import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import Database from 'better-sqlite3'
import { EML, CURRENT_BRAIN_SCHEMA_VERSION } from '../src'
import { validDecision } from './fixtures'

const MIGRATIONS = join(__dirname, '..', 'migrations', 'brain')
const SRC = { source_id: 'x', source_type: 'agent' } as const
const NOW = '2026-08-17T00:00:00.000Z'
const PAST = '2026-08-01T00:00:00.000Z'
const FUTURE = '2026-12-01T00:00:00.000Z'

function decision(eml: EML, title: string, review_due_at: string, extra: Record<string, unknown> = {}) {
  return eml.engrams.store(validDecision({
    scope: 'global', title, content: `decision ${title}`,
    properties: { ...SRC, review_due_at, ...extra },
  }))
}

describe('v0.13 labels — review sweep', () => {
  let dir: string
  let eml: EML

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-labels-test-'))
    eml = new EML({ namespace: 'test', dbPath: join(dir, 't.db') })
  })
  afterEach(() => {
    eml.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('brain schema version includes v0.13', () => {
    expect(CURRENT_BRAIN_SCHEMA_VERSION).toBeGreaterThanOrEqual(13)
  })

  it('migration creates the tables and seeds the `review` label', () => {
    expect(eml.labels.exists('review')).toBe(true)
    expect(eml.labels.list().map(l => l.id)).toContain('review')
  })

  it('stamps `review` on a past-due active decision', () => {
    const d = decision(eml, 'due-one', PAST)
    const n = eml.engrams.stampDueReviewLabels(NOW)
    expect(n).toBe(1)
    expect(eml.engrams.get(d.id)!.labels).toContain('review')
  })

  it('query({ label }) returns only engrams carrying that label (v0.13.x)', () => {
    const due = decision(eml, 'due-labelled', PAST)
    decision(eml, 'not-due', FUTURE)
    eml.engrams.stampDueReviewLabels(NOW)
    const flagged = eml.engrams.query({ label: 'review' })
    expect(flagged.map(e => e.id)).toEqual([due.id])
    expect(eml.engrams.query({ label: 'Review' }).map(e => e.id)).toEqual([due.id]) // slugified like writes
    expect(eml.engrams.query({ label: 'nope' })).toHaveLength(0)
    expect(eml.engrams.query({})).toHaveLength(2)
  })

  it('does NOT stamp a not-yet-due engram', () => {
    decision(eml, 'future', FUTURE)
    expect(eml.engrams.stampDueReviewLabels(NOW)).toBe(0)
  })

  it('does NOT stamp a non-active engram', () => {
    const d = decision(eml, 'dead', PAST)
    eml.engrams.update(d.id, { status: 'superseded' })
    expect(eml.engrams.stampDueReviewLabels(NOW)).toBe(0)
    expect(eml.engrams.get(d.id)!.labels).not.toContain('review')
  })

  it('does NOT stamp a type outside decision/rule/profile', () => {
    // a task carrying a past review_due_at property must be ignored
    eml.engrams.store({
      type: 'task', scope: 'global', title: 't', content: 'a task',
      properties: { ...SRC, review_due_at: PAST, priority: 'normal' },
    })
    expect(eml.engrams.stampDueReviewLabels(NOW)).toBe(0)
  })

  it('is idempotent — a second sweep stamps nothing new', () => {
    decision(eml, 'due', PAST)
    expect(eml.engrams.stampDueReviewLabels(NOW)).toBe(1)
    expect(eml.engrams.stampDueReviewLabels(NOW)).toBe(0)
  })

  it('stamps a legacy SQLite-format review_due_at (space, not ISO)', () => {
    // v0.8 backfilled review_due_at as 'YYYY-MM-DD HH:MM:SS' (SQLite datetime),
    // not ISO-8601 — the sweep normalizes both sides via datetime() so the
    // compare is correct across formats. Start FUTURE, then inject a legacy value.
    const d = decision(eml, 'legacy', FUTURE)
    eml.engrams.update(d.id, { properties: { review_due_at: '2020-01-01 00:00:00' } })
    expect(eml.engrams.stampDueReviewLabels(NOW)).toBe(1)
    expect(eml.engrams.get(d.id)!.labels).toContain('review')
  })

  it('confirmReview clears the review label', () => {
    const d = decision(eml, 'confirm-me', PAST)
    eml.engrams.stampDueReviewLabels(NOW)
    expect(eml.engrams.get(d.id)!.labels).toContain('review')
    eml.engrams.confirmReview(d.id)
    expect(eml.engrams.get(d.id)!.labels).not.toContain('review')
  })

  it('a status transition off active clears the review label', () => {
    const d = decision(eml, 'supersede-me', PAST)
    eml.engrams.stampDueReviewLabels(NOW)
    expect(eml.engrams.get(d.id)!.labels).toContain('review')
    eml.engrams.update(d.id, { status: 'superseded' })
    expect(eml.engrams.get(d.id)!.labels).not.toContain('review')
  })

  it('labels hydrate on query as well as get', () => {
    decision(eml, 'q', PAST)
    eml.engrams.stampDueReviewLabels(NOW)
    const rows = eml.engrams.query({ type: 'decision', scope: 'global' })
    expect(rows[0].labels).toContain('review')
  })

  it('buildBrainState surfaces pending_reviews, separate from open_tasks', () => {
    const d = decision(eml, 'pending', PAST)
    eml.engrams.store({
      type: 'task', scope: 'global', title: 'work', content: 'real work',
      properties: { ...SRC, priority: 'normal' },
    })
    eml.engrams.stampDueReviewLabels(NOW)
    const state = eml.engrams.buildBrainState('global')
    expect(state.pending_reviews!.map(e => e.id)).toContain(d.id)
    expect(state.open_tasks.map(e => e.id)).not.toContain(d.id)
  })
})
