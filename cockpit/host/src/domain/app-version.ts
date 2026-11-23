/**
 * The cockpit's own release versions: the folder names under <home>/app/versions
 * and the tags of its GitHub releases (v<X.Y.Z> or v<X.Y.Z-pre>, such as
 * v0.22.0-alpha.3). The minor is the brain schema (release v0.N ↔ brain schema N).
 * Versions order by semver precedence: a pre-release comes before its release.
 */
const APP_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export const isAppVersion = (value: unknown): value is string => typeof value === 'string' && APP_VERSION_RE.test(value)

export const isPrerelease = (version: string): boolean => version.includes('-')

const NUMERIC_RE = /^\d+$/

function comparePrereleaseIds(a: string, b: string): number {
  const an = NUMERIC_RE.test(a)
  const bn = NUMERIC_RE.test(b)
  if (an && bn) return Math.sign(Number(a) - Number(b))
  if (an !== bn) return an ? -1 : 1
  return a === b ? 0 : a < b ? -1 : 1
}

export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a)
  const [coreB, preB] = splitVersion(b)
  const pa = coreA.split('.').map(Number)
  const pb = coreB.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  if (preA === null || preB === null) return preA === preB ? 0 : preA === null ? 1 : -1
  const ia = preA.split('.')
  const ib = preB.split('.')
  for (let i = 0; i < Math.min(ia.length, ib.length); i++) {
    const order = comparePrereleaseIds(ia[i], ib[i])
    if (order !== 0) return order
  }
  return Math.sign(ia.length - ib.length)
}

function splitVersion(version: string): [string, string | null] {
  const dash = version.indexOf('-')
  return dash < 0 ? [version, null] : [version.slice(0, dash), version.slice(dash + 1)]
}

export function minorOf(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}

/**
 * Which releases an installed cockpit is offered: stable sees releases only,
 * alpha also sees the pre-releases built from the alpha branch (experimental).
 */
export const UPDATE_CHANNELS = ['stable', 'alpha'] as const

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number]

export const isUpdateChannel = (value: unknown): value is UpdateChannel =>
  typeof value === 'string' && (UPDATE_CHANNELS as readonly string[]).includes(value)
