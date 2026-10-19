import type { EML } from './index'
import { REVIEWABLE_TYPES } from './engrams'
import { CURRENT_BRAIN_SCHEMA_VERSION } from './control'
import { formatProblems, RULE_CONTENT_MAX_CHARS, PROFILE_CONTENT_MAX_CHARS, RULE_TRIGGER_MAX_CHARS } from './validate'

type EngramRow = Record<string, any>

// --- Brain hygiene -------------------------------------------------------------
//
// A deterministic check of the brain against what the current schema expects:
// a list of checks, each with what it requires, how an entry is brought in line,
// and the engrams that are not (findings, with a reason each). The cockpit runs
// it (GET /hygiene) to decide when to offer a hygiene session and writes the
// checks with findings to the session's findings.json; the brain-hygiene skill
// works from that file and knows no check itself, so a new requirement needs a
// new check here, not a skill change.
//
// Kinds:
//   migration — a requirement a brain schema introduced for existing engrams.
//               The cockpit offers a hygiene session once per schema migration
//               while one has findings.
//   review    — recurring: engrams due for a re-check, offered once a week.
//
// When a schema changes what an engram must look like: what its migrate SQL can
// rewrite on its own, it rewrites there. A check is for what needs judgement —
// rewriting text, naming a trigger, deciding whether something still holds.
// Add it below with `since_schema` = the brain schema that introduces the
// requirement. A check stays while its requirement holds: new writes are
// validated, so it only finds entries written before.

export type HygieneCheckKind = 'migration' | 'review'

export interface HygieneFinding {
  id: string
  type: string
  scope: string
  title: string | null
  reason: string
}

export interface HygieneCheck {
  id: string
  kind: HygieneCheckKind
  /** Brain schema that introduced the requirement (migration checks only). */
  since_schema?: number
  /** What the check requires, for the agent and the user. */
  what: string
  /** How an entry is brought in line — the skill proposes changes from this. */
  how: string
  detect(eml: EML, now: Date): HygieneFinding[]
}

export interface HygieneCheckResult {
  id: string
  kind: HygieneCheckKind
  since_schema?: number
  what: string
  how: string
  findings: HygieneFinding[]
}

export interface HygieneReport {
  /** The brain schema the checks ran against (an open brain is always migrated to the current one). */
  schema: number
  /** Every check, including the ones without findings. */
  checks: HygieneCheckResult[]
  /** Findings over all checks. */
  total: number
}

function finding(c: EngramRow, reason: string): HygieneFinding {
  return { id: c.id, type: c.type, scope: c.scope, title: c.title ?? null, reason }
}

/**
 * review_due_at as a timestamp, read the way the nightly sweep's SQLite
 * datetime() reads it: a value without a zone ('YYYY-MM-DD HH:MM[:SS]' from the
 * v0.8 backfill, or an ISO string without Z) is UTC, not local time.
 */
function parseDue(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const zoneless = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
  return Date.parse(zoneless ? `${value.replace(' ', 'T')}Z` : value)
}

export const HYGIENE_CHECKS: readonly HygieneCheck[] = [
  {
    id: 'rule-profile-format',
    kind: 'migration',
    since_schema: 18,
    what:
      `Rules and profiles are short, so the boot can carry them whole: a rule's content at most ${RULE_CONTENT_MAX_CHARS} characters ` +
      `and only what to do, a profile's at most ${PROFILE_CONTENT_MAX_CHARS}; a situational rule names its situation in ` +
      `properties.trigger (at most ${RULE_TRIGGER_MAX_CHARS}). Entries written before are shown by title only until they fit.`,
    how:
      'Shorten content to what to do (rule) or the core facts (profile). Move, never drop: the rationale goes to ' +
      'properties.why, playbook and examples to properties.detail. A situational rule gets a trigger that names the ' +
      'situation, not repeated in content. Set properties.boot to null if present (no longer read). One eml_update per ' +
      'entry, content and properties in the same patch.',
    detect(eml) {
      return eml.engrams
        .query({ limit: 10000, status: 'active' })
        .filter((c: EngramRow) => c.type === 'rule' || c.type === 'profile')
        .map((c: EngramRow) => {
          const problems = formatProblems(c.type, c.content, c.properties)
          if (problems.length === 0) return null
          // One sentence per problem, as in the write error (validateFormat).
          return finding(c, problems.map((m, i) => i === 0 ? m : m[0].toUpperCase() + m.slice(1)).join(' '))
        })
        .filter((f): f is HygieneFinding => f !== null)
    },
  },
  {
    id: 'review-due',
    kind: 'review',
    what:
      'Decisions, rules and profiles carry a review date (properties.review_due_at). Due entries are re-checked ' +
      'so stale knowledge does not stay in force.',
    how:
      'Check each entry against what is known now, then one of three. Still holds → eml_update with ' +
      'properties.review_note (why it still holds). Changed → eml_update with the new content. Both restart the ' +
      'review. No longer holds → invalidate with the reason, or supersede if another active engram replaces it. ' +
      'When unsure, ask the user instead of confirming.',
    detect(eml, now) {
      const reviewable = REVIEWABLE_TYPES as readonly string[]
      return (eml.engrams.query({ limit: 10000, status: 'active' }) as EngramRow[])
        .filter((c) => reviewable.includes(c.type) && parseDue(c.properties?.review_due_at) < now.getTime())
        .map((c) => finding(c, `review due since ${new Date(parseDue(c.properties.review_due_at)).toISOString().slice(0, 10)}.`))
    },
  },
]

/** Run every hygiene check against the brain. */
export function hygieneCheck(eml: EML, opts: { now?: Date } = {}): HygieneReport {
  const now = opts.now ?? new Date()
  const checks = HYGIENE_CHECKS.map(({ detect, ...meta }) => ({ ...meta, findings: detect(eml, now) }))
  return { schema: CURRENT_BRAIN_SCHEMA_VERSION, checks, total: checks.reduce((n, c) => n + c.findings.length, 0) }
}
