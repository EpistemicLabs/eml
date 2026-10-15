import type { EML } from './index'
import { REVIEW_LABEL, REVIEWABLE_TYPES } from './engrams'
import { TASK_INACTIVITY_DAYS } from './types'
import { formatProblems, RULE_CONTENT_MAX_CHARS, PROFILE_CONTENT_MAX_CHARS, RULE_TRIGGER_MAX_CHARS } from './validate'

type EngramRow = Record<string, any>

// --- Brain hygiene -------------------------------------------------------------
//
// A deterministic check of the brain against what the current version expects:
// a list of checks, each with what it requires, how an entry is brought in line,
// and the engrams that are not (findings, with a reason each). The cockpit runs
// it (GET /hygiene) to decide when to open a hygiene session and writes the
// checks with findings into that session's prompt; the brain-hygiene skill works
// from there and knows no check itself, so a new requirement needs a new check
// here, not a skill change.
//
// Kinds:
//   migration — a requirement a release introduced for existing engrams. The
//               cockpit opens a hygiene session after an update while one has
//               findings.
//   review    — recurring: engrams due for a re-check.
//
// When a release changes what an engram must look like: what its migrate SQL can
// rewrite on its own, it rewrites there. A check is for what needs judgement —
// rewriting text, naming a trigger, deciding whether something still holds.
// Add it below with `since` = the release that introduces the requirement.

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
  /** Product version that introduced the requirement. */
  since: string
  /** What the check requires, for the agent and the user. */
  what: string
  /** How an entry is brought in line — the skill proposes changes from this. */
  how: string
  detect(eml: EML, now: Date): HygieneFinding[]
}

export interface HygieneCheckResult {
  id: string
  kind: HygieneCheckKind
  since: string
  what: string
  how: string
  findings: HygieneFinding[]
}

export interface HygieneReport {
  /** Every check, including the ones without findings. */
  checks: HygieneCheckResult[]
  /** Findings over all checks. */
  total: number
}

function finding(c: EngramRow, reason: string): HygieneFinding {
  return { id: c.id, type: c.type, scope: c.scope, title: c.title ?? null, reason }
}

/** review_due_at as stored: ISO-8601 from the app, 'YYYY-MM-DD HH:MM:SS' (UTC) from the v0.8 backfill. */
function parseDue(value: unknown): number {
  if (typeof value !== 'string') return NaN
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  return Date.parse(iso)
}

export const HYGIENE_CHECKS: readonly HygieneCheck[] = [
  {
    id: 'rule-profile-format',
    kind: 'migration',
    since: '0.17.18',
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
    since: '0.17.18',
    what:
      `Decisions, rules and profiles carry a review date (properties.review_due_at); an open task is due after ` +
      `${TASK_INACTIVITY_DAYS} days without movement. Due entries are re-checked so stale knowledge does not stay in force.`,
    how:
      'Check each entry against what is known now. Still holds → eml_update with properties.review_note (why it ' +
      'still holds). Changed → eml_update with the new content. Either restarts the review. Replaced → supersede it. ' +
      'Wrong or no longer relevant → invalidate; a finished task → resolve with an outcome, a task still wanted → a ' +
      'task entry. When unsure, ask the user instead of confirming.',
    detect(eml, now) {
      const reviewable = REVIEWABLE_TYPES as readonly string[]
      const out = new Map<string, HygieneFinding>()
      for (const c of eml.engrams.query({ limit: 10000, status: 'active' }) as EngramRow[]) {
        if (!reviewable.includes(c.type)) continue
        const due = parseDue(c.properties?.review_due_at)
        if (due < now.getTime()) {
          out.set(c.id, finding(c, `review due since ${new Date(due).toISOString().slice(0, 10)}.`))
        }
      }
      // The nightly sweep's label also covers open tasks (inactivity).
      for (const c of eml.engrams.query({ limit: 10000, label: REVIEW_LABEL }) as EngramRow[]) {
        if (out.has(c.id)) continue
        const open = c.status === 'active' || (c.type === 'task' && c.status === 'planned')
        if (!open) continue
        out.set(c.id, finding(c, c.type === 'task'
          ? `open task without movement for ${TASK_INACTIVITY_DAYS}+ days.`
          : 'flagged for review.'))
      }
      return [...out.values()]
    },
  },
]

/** Run every hygiene check against the brain. */
export function hygieneCheck(eml: EML, opts: { now?: Date } = {}): HygieneReport {
  const now = opts.now ?? new Date()
  const checks = HYGIENE_CHECKS.map(({ detect, ...meta }) => ({ ...meta, findings: detect(eml, now) }))
  return { checks, total: checks.reduce((n, c) => n + c.findings.length, 0) }
}
