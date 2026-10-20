import { describe, it, expect } from 'vitest'
import { idsInOrder, score, summarize, type Question, type RetrievalResult } from '../src/retrieval'
import type { Brain } from '../src/fixture'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const brain = {
  ids: { cur: A, old: B, other: C },
  titles: { cur: 'shop-platform', old: 'shop-platform-old', other: 'other' },
} as unknown as Brain

const recall = (expect: string[], stale: string[] = []): Question =>
  ({ id: 'q', category: 'c', retrieval: { tool: 'recall', query: 'x' }, expect, stale, agent: null })

describe('idsInOrder', () => {
  it('lists each id once, in order of first appearance', () => {
    expect(idsInOrder(`id: ${C}\nid: ${A} … ${C}\nid: ${B}`)).toEqual([C, A, B])
  })
})

describe('score', () => {
  it('ranks the best expected engram and flags a stale one above it', () => {
    const s = score(recall(['cur'], ['old']), `${C}\n${B}\n${A}`, brain)
    expect(s.rank).toBe(3)
    expect(s.stale_hit).toBe(true)
  })

  it('does not flag a stale engram below the current one', () => {
    expect(score(recall(['cur'], ['old']), `${A}\n${B}`, brain).stale_hit).toBe(false)
  })

  it('treats a missing expected engram as not found', () => {
    const s = score(recall(['cur']), `${C}`, brain)
    expect(s.rank).toBeNull()
    expect(s.found).toBe(0)
  })

  it('scores show by presence and flags absent engrams', () => {
    const q: Question = { id: 'q', category: 'c', retrieval: { tool: 'show', scope: 'project.x' }, expect: ['cur'], absent: ['old'], agent: null }
    const s = score(q, `${C}\n${A}\n${B}`, brain)
    expect(s.rank).toBe(1)
    expect(s.absent_hit).toBe(true)
  })

  it('scores the boot by title', () => {
    const q: Question = { id: 'q', category: 'boot', retrieval: { tool: 'boot' }, expect: ['cur'], agent: null }
    expect(score(q, '- **[global | shop-platform]** …', brain).rank).toBe(1)
  })
})

describe('summarize', () => {
  it('computes recall@5 and MRR, stale rate only over questions that name stale engrams', () => {
    const base = { id: 'q', category: 'c', tool: 'recall', found: 1, expected: 1, absent_hit: false, chars: 10, ms: 1 }
    const results: RetrievalResult[] = [
      { ...base, rank: 1, stale_hit: false, stale_checked: true },
      { ...base, rank: 2, stale_hit: true, stale_checked: true },
      { ...base, rank: 9, stale_hit: false, stale_checked: false },
      { ...base, rank: null, found: 0, stale_hit: false, stale_checked: false },
    ]
    const s = summarize(results)
    expect(s.recall_at_k).toBe(0.5)
    expect(s.mrr).toBeCloseTo((1 + 0.5 + 1 / 9) / 4, 3)
    expect(s.stale_rate).toBe(0.5)
  })
})
