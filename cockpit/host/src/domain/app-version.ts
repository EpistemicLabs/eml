/**
 * The cockpit's own release versions: the folder names under <home>/app/versions
 * and the tags of its GitHub releases (v<X.Y.Z>). The minor is the brain schema
 * (release v0.N ↔ brain schema N).
 */
const APP_VERSION_RE = /^\d+\.\d+\.\d+$/

export const isAppVersion = (value: unknown): value is string => typeof value === 'string' && APP_VERSION_RE.test(value)

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

export function minorOf(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}
