import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect } from 'vitest'
import { compareVersions, findBaseline, knownHashes, retrievalRegressions } from '../src/baseline'
import type { RetrievalSummary } from '../src/retrieval'

describe('compareVersions', () => {
  it('orders numerically', () => {
    expect(compareVersions('0.18.10', '0.18.9')).toBeGreaterThan(0)
    expect(compareVersions('0.19.0', '0.19.0')).toBe(0)
    expect(compareVersions('0.9.1', '0.18.0')).toBeLessThan(0)
  })
})

describe('findBaseline', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-results-'))
  const put = (version: string, hash: string) =>
    fs.writeFileSync(path.join(dir, `${version}.json`), JSON.stringify({ version, fixture_hash: hash }))
  put('0.18.2', 'h1')
  put('0.18.3', 'h1')
  put('0.19.0', 'h2')

  it('takes the newest result on the same fixture before the version', () => {
    expect(findBaseline('0.18.4', 'h1', false, dir)?.data.version).toBe('0.18.3')
    expect(findBaseline('0.18.3', 'h1', false, dir)?.data.version).toBe('0.18.2')
  })

  it('includes the version itself for a branch on top of a release', () => {
    expect(findBaseline('0.18.3', 'h1', true, dir)?.data.version).toBe('0.18.3')
  })

  it('lists the fixtures results exist for, none for an empty or missing dir', () => {
    expect(knownHashes(dir).sort()).toEqual(['h1', 'h2'])
    expect(knownHashes(path.join(dir, 'missing'))).toEqual([])
  })

  it('skips results on another fixture', () => {
    expect(findBaseline('0.20.0', 'h1', false, dir)?.data.version).toBe('0.18.3')
    expect(findBaseline('0.20.0', 'h3', false, dir)).toBeNull()
  })
})

describe('retrievalRegressions', () => {
  const s = (o: Partial<RetrievalSummary>) => ({ recall_at_k: 0.9, mrr: 0.8, coverage: 1, stale_rate: 0.1, absent_rate: 0, ...o }) as RetrievalSummary
  it('reports only what got worse', () => {
    expect(retrievalRegressions(s({}), s({ mrr: 0.85, stale_rate: 0.05 }))).toEqual([])
    expect(retrievalRegressions(s({}), s({ mrr: 0.75, absent_rate: 0.02 }))).toHaveLength(2)
  })
})
