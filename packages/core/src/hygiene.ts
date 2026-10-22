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

/**
 * Who decides a finding (decision hygiene-agent-decides-by-check): agent = the
 * agent writes the clear cases itself and asks only where it is unsure; user =
 * it needs the user's word (e.g. a rule's agreement).
 */
export type HygieneDecider = 'agent' | 'user'

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
  decides: HygieneDecider
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
  decides: HygieneDecider
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

const SCHEMA_18_CHECKS: readonly HygieneCheck[] = [
  {
    id: 'rule-profile-format',
    kind: 'migration',
    decides: 'agent',
    since_schema: 18,
    what:
      `Rules and profiles are short, so the boot can carry them whole: a rule's content at most ${RULE_CONTENT_MAX_CHARS} characters ` +
      `and only what to do, a profile's at most ${PROFILE_CONTENT_MAX_CHARS}; a situational rule names its situation in ` +
      `trigger (at most ${RULE_TRIGGER_MAX_CHARS}). Entries written before are shown by title only until they fit.`,
    how:
      'Shorten content to what to do (rule) or the core facts (profile). Move, never drop: the rationale goes to ' +
      'why, playbook and examples to detail. A situational rule gets a trigger that names the situation, not repeated ' +
      'in content. One eml_update per entry, content and the fields in the same call.',
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
    decides: 'agent',
    what:
      'Decisions, rules and profiles carry a review date (review_due_at). Due entries are re-checked so stale ' +
      'knowledge does not stay in force.',
    how:
      'Check each entry against what is known now, then one of three. Still holds → eml_update with review_note ' +
      '(why it still holds; it becomes a review entry). Changed → eml_update with the new content. Both restart the ' +
      'review. No longer holds → eml_update status=invalidated, or, if another active engram replaces it, ' +
      'eml_update(<that engram>, supersedes=[<this id>]). When unsure, ask the user instead of confirming.',
    detect(eml, now) {
      const reviewable = REVIEWABLE_TYPES as readonly string[]
      return (eml.engrams.query({ limit: 10000, status: 'active' }) as EngramRow[])
        // a task-bound decision is not reviewed; its task covers it
        .filter((c) => reviewable.includes(c.type) && (c.properties?.binding ?? 'standing') === 'standing'
          && parseDue(c.properties?.review_due_at) < now.getTime())
        .map((c) => finding(c, `review due since ${new Date(parseDue(c.properties.review_due_at)).toISOString().slice(0, 10)}.`))
    },
  },
]

// --- Schema 19 (v0.19 tool surface) ------------------------------------------------
//
// What the v0.19 migration could not decide on its own: whether a reference is
// really a pointer, where a misfiled profile belongs, which engram succeeded a
// superseded one, why a rule holds and whether the user agreed to it, and
// whether a decision or note taken in a task outlives it.

const ACTIVE = (eml: EML): EngramRow[] => eml.engrams.query({ limit: 100000, status: 'active' }) as EngramRow[]

const SCHEMA_19_CHECKS: readonly HygieneCheck[] = [
  {
    id: 'reference-without-source',
    kind: 'migration',
    decides: 'agent',
    since_schema: 19,
    what:
      'A reference points to something outside the brain and names it in source (URL, repo path, document id). ' +
      'Many older references are syntheses or working theses that live in the brain — those are notes.',
    how:
      'Points outside → eml_update with source (and source_name, checked_at if known). Lives in the brain → write it ' +
      'as a note (eml_note, same title and content) with supersedes=[<reference id>]; the type of an engram never ' +
      'changes in place.',
    detect(eml) {
      return ACTIVE(eml)
        .filter(c => c.type === 'reference' && (typeof c.properties?.source !== 'string' || c.properties.source.trim() === ''))
        .map(c => finding(c, 'no source.'))
    },
  },
  {
    id: 'profile-scope',
    kind: 'migration',
    decides: 'agent',
    since_schema: 19,
    what:
      'A profile is about someone: it lives in agent.<id>, user.<id> or entity.<id>. Setup, access and how-to ' +
      'information is a note or a reference, a way of working a rule.',
    how:
      'Write it as the type it is (eml_note / eml_reference / eml_rule — a rule only with the user\'s yes) with ' +
      'supersedes=[<profile id>]. If it really is a facet of someone, write it as a profile in their scope with ' +
      'supersedes=[<profile id>].',
    detect(eml) {
      return ACTIVE(eml)
        .filter(c => c.type === 'profile' && !/^(agent|user|entity)\./.test(c.scope))
        .map(c => finding(c, `profile in ${c.scope}.`))
    },
  },
  {
    id: 'rule-without-why',
    kind: 'migration',
    decides: 'agent',
    since_schema: 19,
    what: 'A rule says why it holds (why). New rules need it; older ones were written without.',
    how:
      'Find the reason in the rule, its detail and its history (eml_get) and set it with eml_update(why). No ' +
      'reason to be found → ask the user whether the rule should stay.',
    detect(eml) {
      return ACTIVE(eml)
        .filter(c => c.type === 'rule' && (typeof c.properties?.why !== 'string' || c.properties.why.trim() === ''))
        .map(c => finding(c, 'no why.'))
    },
  },
  {
    id: 'rule-without-agreement',
    kind: 'migration',
    decides: 'user',
    since_schema: 19,
    what:
      'A rule is agreed with the user (agreed holds their yes). Older rules were often written after a single ' +
      'incident; what the agent noticed on its own is a learning until it recurs and the user agrees.',
    how:
      'List the rules compactly (title and one line each) and ask once whether to keep them as rules. Every rule ' +
      'their answer does not except → eml_update(agreed=<their answer>). Each exception: no longer wanted → ' +
      'eml_update(status=invalidated); one incident, not a rule yet → a learning (eml_learning: the rule as the ' +
      'lesson, the incident as evidence), then eml_update(<learning id>, supersedes=[<rule id>]); wanted but ' +
      'changed → new content and agreed in one call. rule-without-why runs first.',
    detect(eml) {
      return ACTIVE(eml)
        .filter(c => c.type === 'rule' && (typeof c.properties?.agreed !== 'string' || c.properties.agreed.trim() === ''))
        .map(c => finding(c, 'no agreement recorded.'))
    },
  },
  {
    id: 'task-link-without-binding',
    kind: 'migration',
    decides: 'agent',
    since_schema: 19,
    what:
      'A decision or note taken in a task says whether it outlives the task (binding standing) or only governs ' +
      'how the task is done (binding task; it closes with the task). Without binding it counts as standing.',
    how:
      'Decide: does it still constrain work once the task is done? Yes → eml_update(binding=standing). No → task still ' +
      'open: eml_update(binding=task); task already closed: eml_update(status=invalidated).',
    detect(eml) {
      const linked = new Map(eml.engrams.taskLinkedItems().map(r => [r.id, r.task_status]))
      return ACTIVE(eml)
        .filter(c => (c.type === 'decision' || c.type === 'note') && linked.has(c.id) && c.properties?.binding === undefined)
        .map(c => finding(c, `taken in a task (${linked.get(c.id)}), no binding.`))
    },
  },
  {
    id: 'decision-without-rationale',
    kind: 'migration',
    decides: 'agent',
    since_schema: 19,
    what:
      'A decision names its rationale and at least one rejected alternative — without them it is a note, not a ' +
      'choice. New decisions need both; older ones were written without.',
    how:
      'Find the rationale and the alternatives in the decision, its detail and its history (eml_get) and set them ' +
      'with eml_update(rationale, alternatives). Nothing was weighed → it is a note: eml_note (same title and ' +
      'content) with supersedes=[<decision id>]. Unsure → ask the user.',
    detect(eml) {
      return ACTIVE(eml)
        .filter(c => c.type === 'decision' && (typeof c.properties?.rationale !== 'string' || c.properties.rationale.trim() === ''
          || !Array.isArray(c.properties?.alternatives) || c.properties.alternatives.length === 0))
        .map(c => finding(c, [
          (typeof c.properties?.rationale !== 'string' || c.properties.rationale.trim() === '') ? 'no rationale' : null,
          (!Array.isArray(c.properties?.alternatives) || c.properties.alternatives.length === 0) ? 'no alternatives' : null,
        ].filter(Boolean).join(', ') + '.'))
    },
  },
]

// --- Learnings (recurring) ----------------------------------------------------------
//
// A learning is never binding, so nothing forces a look at it: an unclear one
// (open contradiction) waits for the user's word. Age alone is no reason to
// look — the agent keeps its learnings itself (decision review-per-type).

const LEARNING_CHECKS: readonly HygieneCheck[] = [
  {
    id: 'learning-unclear',
    kind: 'review',
    decides: 'user',
    what:
      'A learning with contradicting evidence is unclear: the lesson as written does not hold in every case. It ' +
      'stays unclear until its content is sharpened or it is dropped.',
    how:
      'Show the user the lesson and the evidence for and against (eml_get) and ask what the lesson really is. ' +
      'Sharpen it with eml_update(content) — the contradiction counts as settled from then on — or drop it with ' +
      'eml_update(status=invalidated).',
    detect(eml) {
      return ACTIVE(eml)
        .filter(c => c.type === 'learning' && eml.engrams.learningStateOf(c.id).state === 'unclear')
        .map(c => finding(c, 'contradicting evidence is open.'))
    },
  },
]

/** Every check, migration checks by schema, then the recurring review. */
export const HYGIENE_CHECKS: readonly HygieneCheck[] = [
  ...SCHEMA_18_CHECKS.filter(c => c.kind === 'migration'),
  ...SCHEMA_19_CHECKS,
  ...SCHEMA_18_CHECKS.filter(c => c.kind === 'review'),
  ...LEARNING_CHECKS,
]

/** Run every hygiene check against the brain. */
export function hygieneCheck(eml: EML, opts: { now?: Date } = {}): HygieneReport {
  const now = opts.now ?? new Date()
  const checks = HYGIENE_CHECKS.map(({ detect, ...meta }) => ({ ...meta, findings: detect(eml, now) }))
  return { schema: CURRENT_BRAIN_SCHEMA_VERSION, checks, total: checks.reduce((n, c) => n + c.findings.length, 0) }
}
