import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type Database from 'better-sqlite3'
import { initControlDatabase, provisionUser, EML } from '@engramprotocol/core'
import { runReviewSweep } from '../src/review-sweep'
import { validDecision } from '../../core/tests/fixtures'

/**
 * v0.13: the nightly review-sweep across registered brains. Provisions a real
 * brain (schema 13, status ok) via provisionUser, seeds a past-due decision,
 * then runs the sweep and asserts the `review` label was stamped in that brain.
 */
describe('runReviewSweep', () => {
  let control: Database.Database
  let dataDir: string

  beforeEach(() => {
    control = initControlDatabase(':memory:')
    dataDir = mkdtempSync(join(tmpdir(), 'eml-review-sweep-test-'))
  })
  afterEach(() => {
    control.close()
    rmSync(dataDir, { recursive: true, force: true })
  })

  function seedDueDecision(brainFile: string): string {
    const eml = new EML({ namespace: 'test', dbPath: join(dataDir, brainFile) })
    const d = eml.engrams.store(validDecision({
      scope: 'global', title: 'stale', content: 'a stale decision',
      properties: {
        review_due_at: '2020-01-01T00:00:00.000Z', // long past
      },
    }))
    eml.close()
    return d.id
  }

  it('stamps `review` on a past-due decision in a registered brain', () => {
    const prov = provisionUser({ email: 'a@b.de', agentId: 'ag', userId: 'u', control, dataDir })
    const id = seedDueDecision(prov.brainFile)

    const report = runReviewSweep({ control, dataDir })

    expect(report.totalBrains).toBe(1)
    expect(report.failedCount).toBe(0)
    expect(report.stampedCount).toBeGreaterThanOrEqual(1)

    const eml = new EML({ namespace: 'test', dbPath: join(dataDir, prov.brainFile) })
    expect(eml.engrams.get(id)!.labels).toContain('review')
    eml.close()
  })

  it('is idempotent — a second sweep stamps nothing new', () => {
    const prov = provisionUser({ email: 'a@b.de', agentId: 'ag', userId: 'u', control, dataDir })
    seedDueDecision(prov.brainFile)

    expect(runReviewSweep({ control, dataDir }).stampedCount).toBeGreaterThanOrEqual(1)
    expect(runReviewSweep({ control, dataDir }).stampedCount).toBe(0)
  })

  it('skips brains flagged needs_intervention', () => {
    const prov = provisionUser({ email: 'a@b.de', agentId: 'ag', userId: 'u', control, dataDir })
    seedDueDecision(prov.brainFile)
    control.prepare(`UPDATE brains SET status = 'needs_intervention' WHERE id = ?`).run(prov.brainId)

    const report = runReviewSweep({ control, dataDir })
    expect(report.totalBrains).toBe(0)
    expect(report.stampedCount).toBe(0)
  })
})
