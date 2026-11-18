import { ownVersion, readAppUpdateStatus, releaseHighlightsBetween, releasePageUrl } from './app-update.js'
import { acknowledgeReleaseRange, readReleasePreviewState, releaseVersionWasAcknowledged, storePendingReleasePreview, type ReleasePreviewItem, type ReleasePreviewRound } from './release-preview-state.js'

export type ReleasePreview = { from: string; to: string; releases: ReleasePreviewItem[]; fallback: boolean }

function fallbackRelease(version: string): ReleasePreviewItem {
  return { version, url: releasePageUrl(version), highlights: [] }
}

function currentRange(): { from: string; to: string } | null {
  const status = readAppUpdateStatus()
  const result = status.lastResult
  if (!result || result.outcome !== 'updated' || !result.from || !result.to || result.to !== ownVersion()) return null
  return { from: result.from, to: result.to }
}

function matchingPending(from: string, to: string): ReleasePreviewRound | null {
  const pending = readReleasePreviewState().pending
  return pending?.from === from && pending.to === to ? pending : null
}

function visible(releases: ReleasePreviewItem[]): ReleasePreviewItem[] {
  return releases.filter((release) => !releaseVersionWasAcknowledged(release.version))
}

/** Read the successful update's notes, retrying incomplete cached data after restart. */
export async function readReleasePreview(): Promise<ReleasePreview | null> {
  const range = currentRange()
  if (!range) return null

  let pending = matchingPending(range.from, range.to)
  if (!pending || !pending.complete) {
    let releases: ReleasePreviewItem[] | null = null
    try {
      releases = await releaseHighlightsBetween(range.from, range.to)
    } catch { /* keep the target release link as a network fallback */ }
    if (releases) pending = { ...range, releases: releases.length ? releases : [fallbackRelease(range.to)], complete: true }
    else pending = pending ?? { ...range, releases: [fallbackRelease(range.to)], complete: false }
    try { storePendingReleasePreview(pending) }
    catch { /* preview content can still be shown even if its cache cannot be written */ }
  }

  const releases = visible(pending.releases)
  return releases.length ? { ...range, releases, fallback: !pending.complete || releases.every((r) => r.highlights.length === 0) } : null
}

export function acknowledgeCurrentReleasePreview(): boolean {
  const range = currentRange()
  if (!range) return false
  acknowledgeReleaseRange(range.from, range.to)
  return true
}
