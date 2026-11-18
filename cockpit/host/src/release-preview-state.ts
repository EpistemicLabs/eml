import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { COCKPIT_HOME } from './paths.js'

export type ReleasePreviewItem = { version: string; url: string; highlights: string[] }
export type ReleasePreviewRound = { from: string; to: string; releases: ReleasePreviewItem[]; complete: boolean }

type VersionRange = { from: string; to: string }
export type ReleasePreviewState = { acknowledged: VersionRange[]; pending: ReleasePreviewRound | null }

const STATE_FILE = path.join(COCKPIT_HOME, 'release-preview.json')
const DEFAULT_STATE: ReleasePreviewState = { acknowledged: [], pending: null }
const VERSION_RE = /^\d+\.\d+\.\d+$/

function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number)
  const right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1
  return 0
}

export function readReleasePreviewState(): ReleasePreviewState {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<ReleasePreviewState>
    const pending = parsed.pending
    let validPending = pending && VERSION_RE.test(pending.from) && VERSION_RE.test(pending.to)
      && typeof pending.complete === 'boolean' && Array.isArray(pending.releases)
      ? {
        ...pending,
        releases: pending.releases.filter((release) => release && VERSION_RE.test(release.version)
          && typeof release.url === 'string' && Array.isArray(release.highlights)
          && release.highlights.every((highlight) => typeof highlight === 'string')),
      }
      : null
    if (validPending && validPending.releases.length === 0) validPending = null
    return {
      acknowledged: Array.isArray(parsed.acknowledged)
        ? parsed.acknowledged.filter((r): r is VersionRange => !!r && typeof r.from === 'string' && typeof r.to === 'string' && VERSION_RE.test(r.from) && VERSION_RE.test(r.to))
        : [],
      pending: validPending,
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(state: ReleasePreviewState): void {
  fs.mkdirSync(COCKPIT_HOME, { recursive: true })
  const temp = `${STATE_FILE}.${randomBytes(4).toString('hex')}`
  fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temp, STATE_FILE)
}

export function storePendingReleasePreview(round: ReleasePreviewRound): void {
  const state = readReleasePreviewState()
  writeState({ ...state, pending: round })
}

export function releaseVersionWasAcknowledged(version: string, ranges = readReleasePreviewState().acknowledged): boolean {
  return ranges.some((range) => compareVersions(version, range.from) > 0 && compareVersions(version, range.to) <= 0)
}

export function acknowledgeReleaseRange(from: string, to: string): void {
  if (!VERSION_RE.test(from) || !VERSION_RE.test(to) || compareVersions(from, to) >= 0) throw new Error('invalid release preview range')
  const state = readReleasePreviewState()
  if (state.acknowledged.some((range) => range.from === from && range.to === to)) return
  writeState({ ...state, acknowledged: [...state.acknowledged, { from, to }] })
}
