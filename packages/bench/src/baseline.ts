import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { FIXTURE_DIR } from './fixture'
import type { RetrievalSummary } from './retrieval'

// --- Baselines --------------------------------------------------------------------------
//
// results/<version>.json is the checked-in measurement of a release. A new build
// is compared with the newest result measured on the same fixture: the fixture
// hash says whether two results can be compared at all. Changing the fixture or
// the questions therefore means measuring the last release again (eml-bench
// release on its checkout) — otherwise there is nothing to compare with.

export const RESULTS_DIR = path.resolve(__dirname, '../results')

/** Hash over everything a measurement depends on in the fixture. */
export function fixtureHash(): string {
  const h = crypto.createHash('sha256')
  for (const f of ['brain.json', 'volume.json', 'questions.json', 'scenarios.json']) {
    const p = path.join(FIXTURE_DIR, f)
    if (fs.existsSync(p)) h.update(f).update(fs.readFileSync(p))
  }
  return h.digest('hex').slice(0, 16)
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0)
  const pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

export interface ResultFile {
  file: string
  data: any
}

/**
 * The newest checked-in result on the same fixture, measured on a version
 * before `version` — or up to and including it (`inclusive`): a branch on top
 * of a release compares with that release; a release compares with the one
 * before it.
 */
export function findBaseline(version: string, hash: string, inclusive: boolean, dir = RESULTS_DIR): ResultFile | null {
  if (!fs.existsSync(dir)) return null
  const candidates = fs.readdirSync(dir)
    .filter(f => /^\d+\.\d+\.\d+\.json$/.test(f))
    .map(f => ({ file: path.join(dir, f), data: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }))
    .filter(r => r.data.fixture_hash === hash && (inclusive ? compareVersions(r.data.version, version) <= 0 : compareVersions(r.data.version, version) < 0))
    .sort((a, b) => compareVersions(b.data.version, a.data.version))
  return candidates[0] ?? null
}

/** The fixture hashes of all checked-in results — empty in a repository that has none yet. */
export function knownHashes(dir = RESULTS_DIR): string[] {
  if (!fs.existsSync(dir)) return []
  const hashes = fs.readdirSync(dir)
    .filter(f => /^\d+\.\d+\.\d+\.json$/.test(f))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).fixture_hash as string)
  return [...new Set(hashes)]
}

/**
 * Stage-1 regressions of b against a. Stage 1 is deterministic: on the same
 * fixture any drop is a real change in what the agent gets to read.
 */
export function retrievalRegressions(a: RetrievalSummary, b: RetrievalSummary): string[] {
  const out: string[] = []
  const worse = (name: string, x: number, y: number, higherIsBetter: boolean) => {
    if (higherIsBetter ? y < x : y > x) out.push(`${name} ${x.toFixed(3)} → ${y.toFixed(3)}`)
  }
  worse('recall@k', a.recall_at_k, b.recall_at_k, true)
  worse('MRR', a.mrr, b.mrr, true)
  worse('coverage', a.coverage, b.coverage, true)
  worse('stale rate', a.stale_rate, b.stale_rate, false)
  worse('absent rate', a.absent_rate, b.absent_rate, false)
  return out
}
