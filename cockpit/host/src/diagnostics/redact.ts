import { createHash } from 'node:crypto'

/**
 * Redaction for diagnostics that go into a public GitHub issue (report-issue
 * skill, `eml-cockpit diagnose`). Deterministic and in code, so what leaves the
 * machine does not depend on an agent's judgement:
 *
 *   - known personal strings (project folders and names, space and brain
 *     names) → <project-N>, <name-N>, longest first
 *   - the cockpit home → <cockpit-home> (its layout helps, and is no one's own),
 *     the home folder → ~, the OS user name → <user>
 *   - any other path below the home folder → ~/<path-xxxx>
 *   - secrets: cockpit and brain tokens, API keys, Bearer values, long hex,
 *     JWTs, e-mail addresses, URL query strings
 *   - UUIDs → <id-xxxx>, the same short hash for the same id, so lines about one
 *     session can still be followed
 */

export interface RedactionContext {
  /** The cockpit home (EML_COCKPIT_HOME); kept readable as <cockpit-home>. */
  cockpitHome: string
  home: string
  user: string
  /** Project folders, most specific first after sorting; replaced as <project-N>. */
  paths: string[]
  /** Project, space and brain names; replaced as <name-N>. */
  names: string[]
}

const short = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 6)
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Both separator styles of a path, for logs that print Windows paths either way. */
const variants = (p: string) => [...new Set([p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')])]

export function createRedactor(ctx: RedactionContext): (text: string) => string {
  const byLength = (a: string, b: string) => b.length - a.length
  const paths = [...new Set(ctx.paths.filter((p) => p && p.length > 3))].sort(byLength)
  // A name shorter than four characters ("eml", "cs") would hit ordinary words.
  const names = [...new Set(ctx.names.map((n) => n.trim()).filter((n) => n.length >= 4))].sort(byLength)

  const replacements: Array<[RegExp, string]> = []
  paths.forEach((p, i) => {
    for (const v of variants(p)) replacements.push([new RegExp(escape(v), 'gi'), `<project-${i + 1}>`])
  })
  if (ctx.cockpitHome) for (const v of variants(ctx.cockpitHome)) replacements.push([new RegExp(escape(v), 'gi'), '<cockpit-home>'])
  if (ctx.home) for (const v of variants(ctx.home)) replacements.push([new RegExp(escape(v), 'gi'), '~'])
  names.forEach((n, i) => replacements.push([new RegExp(`(?<![\\w-])${escape(n)}(?![\\w-])`, 'gi'), `<name-${i + 1}>`]))

  const secrets: Array<[RegExp, string]> = [
    [/\beml_[A-Za-z0-9_-]{8,}/g, '<token>'],
    [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, '<token>'],
    [/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{16,}/g, '<token>'],
    [/(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 <token>'],
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '<token>'],
    [/\b[0-9a-f]{24,}\b/gi, '<token>'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<email>'],
    [/(https?:\/\/[^\s?#'"]+)\?[^\s'"]*/g, '$1?<query>'],
  ]

  return (text: string) => {
    let out = text
    for (const [re, to] of replacements) out = out.replace(re, to)
    // Whatever else lives below the home folder: the folder names are the user's.
    out = out.replace(/~[\\/][^\s'"()<>,;]+/g, (m) => `~/<path-${short(m)}>`)
    out = out.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, (m) => `<id-${short(m.toLowerCase())}>`)
    for (const [re, to] of secrets) out = out.replace(re, to)
    if (ctx.user && ctx.user.length >= 3) out = out.replace(new RegExp(`(?<![\\w-])${escape(ctx.user)}(?![\\w-])`, 'gi'), '<user>')
    return out
  }
}
