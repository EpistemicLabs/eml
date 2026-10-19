import type { EML } from './index'
import type { SystemRule } from './system-rules'
import { isLegacyFormat } from './validate'

type EngramRow = Record<string, any>

export interface BootResult {
  agent: string
  engrams: number
  open_tasks: number
  recent_logs: number
  stale_status: number
  overdue_review: number
  /** Rules and core profiles in the boot that do not fit the current format (shown by title only). */
  legacy: number
  version?: string
  markdown: string
  /** Present when a budget was given: what the markdown had to give up to fit. */
  budget?: BootBudgetReport
}

export interface BootOptions {
  reviewDays?: number
  version?: string
  systemRules?: SystemRule[]
  /**
   * The user the session works for (user.<id> scope). Omitted: every user of
   * the brain — in a single-user brain, that user.
   */
  user?: string
  /**
   * Hard cap for `markdown`, in characters (string length). The caller passes
   * the limit of the harness and output form it serves — see "Size budget"
   * below. Omitted: unbounded (tests, CLI).
   */
  budget?: number
}

export interface BootBudgetReport {
  /** The cap that was applied. */
  limit: number
  /** `markdown.length` after the fallback. */
  chars: number
  /** Situational rules listed by title only to fit (their trigger dropped). */
  situational_title_only: number
  /** Always-rules listed by title only to fit. */
  always_title_only: number
  /** Profiles beyond the first two listed by title only to fit. */
  profiles_title_only: number
  /** Entries left out of the boot entirely because even title + id was over the limit. */
  left_out: number
  /** False only when nothing more can give way (system rules and the first two profiles alone are over the limit). */
  fits: boolean
}

// --- What boots ----------------------------------------------------------------
//
// Model: note rule-delivery-model-draft. The boot carries the rules and the
// identity of the scopes that hold for every session — global, agent.<self>,
// user.<self> — and nothing of a project (the project block brings those).
// Selection is by scope; properties.boot is no longer read.
//
//   Identity      — the core profiles: per agent.<self> and user.<self> the one
//                   titled <id> or <id>-identity. Block capped at
//                   IDENTITY_MAX_CHARS; other profiles stay out of the boot.
//   Rules always  — in full: binding within their scope and delivered unasked.
//   Rules situational — an index of title + trigger + id; the agent fetches the
//                   rule with eml_get when the trigger applies.
//   System rules  — the protocol's own (ALL_RULES), always whole.
//   Footer        — only when something is listed by title only: how many
//                   entries gave way to the budget, how many are legacy.
//
// Rules and profiles are short at the source (validate.ts, formatProblems), so
// nothing is ever cut mid-text: an entry is shown whole or by title + id.
// Legacy entries (written before the format) are shown by title + id and
// counted in the footer.

const IDENTITY_MAX_CHARS = 1_500
/** Profiles the overflow ladder never touches: the agent's own and the first user's. */
const CORE_PROFILES_KEPT = 2

const PRIORITY_RANK: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 }

// --- Size budget -------------------------------------------------------------
//
// Why: the boot reaches the model through a SessionStart hook, and the harness
// caps what one hook may inject. Claude Code (verified in the bundled code of
// 2.1.287, 2026-10-13): a hook's plain stdout above 10,000 characters (JS
// string length, per hook output) is written to a file and the model only
// gets a 2,000-char preview — the boot would then be mostly unread, silently.
// Its JSON envelope (hookSpecificOutput.additionalContext) is cut earlier, at
// 8,000 chars / 200 lines; other harnesses (Codex) have their own, unmeasured
// limits. So the limit is the CALLER's to know: the hook passes the budget of
// the harness and output form it serves (decision boot-budget-per-harness).
//
// Invariant: the markdown stays within the budget. What gives way, one whole
// entry at a time, until it fits — each falls back to title + id: situational
// rules (from the last), then always-rules (longest first), then profiles
// beyond the first two. A brain still over the limit with every entry at
// title + id (some 60 rules) then leaves entries out entirely, in the same
// order. System rules and the first two profiles are never touched; the system
// rules are ours and kept small by a test (boot-budget.test.ts), so the
// markdown fits. fits=false would mean they alone are over the limit; the
// markdown is returned anyway and the hook logs it.

function entryMeta(c: EngramRow): string {
  return `[${c.scope} | ${c.title || '(untitled)'}]`
}

function fullLine(c: EngramRow): string {
  return `- **${entryMeta(c)}** ${c.content}`
}

function titleOnlyLine(c: EngramRow): string {
  return `- ${entryMeta(c)} · ${c.id}`
}

/** agent.<self> first, then user.<self>, then global; by title within a scope. */
function scopeOrder(agentScope: string) {
  const rank = (s: string) => (s === agentScope ? 0 : s.startsWith('user.') ? 1 : 2)
  return (a: EngramRow, b: EngramRow) =>
    rank(a.scope) - rank(b.scope) || a.scope.localeCompare(b.scope) || (a.title ?? '').localeCompare(b.title ?? '')
}

export function boot(eml: EML, agentId: string, opts: BootOptions = {}): BootResult {
  const reviewDays = opts.reviewDays ?? 14
  const systemRules = opts.systemRules ?? []

  const agentScope = `agent.${agentId}`
  const userIds = opts.user !== undefined ? [opts.user] : eml.users.list().map(u => u.id)
  const userScopes = userIds.map(id => `user.${id}`)
  const bootScopes = new Set(['global', agentScope, ...userScopes])
  const order = scopeOrder(agentScope)

  const active = eml.engrams
    .query({ limit: 10000, status: 'active' })
    .filter((c: EngramRow) => (c.type === 'rule' || c.type === 'profile') && bootScopes.has(c.scope))
  const legacy = (c: EngramRow) => isLegacyFormat(c.type, c.content, c.properties)

  // Core profiles: the one per self scope titled <id> or <id>-identity.
  const coreProfile = (scope: string, id: string): EngramRow | undefined =>
    active.find((c: EngramRow) => c.type === 'profile' && c.scope === scope && (c.title === id || c.title === `${id}-identity`))
  const profiles = [coreProfile(agentScope, agentId), ...userIds.map(id => coreProfile(`user.${id}`, id))]
    .filter((c): c is EngramRow => c !== undefined)

  const rules = active.filter((c: EngramRow) => c.type === 'rule').sort(order)
  const always = rules.filter((c: EngramRow) => c.properties?.applies === 'always')
  const situational = rules.filter((c: EngramRow) => c.properties?.applies === 'situational')
  const legacyCount = [...profiles, ...rules].filter(legacy).length

  // Identity: whole profiles while the block stays within IDENTITY_MAX_CHARS.
  // capped = well-formed profiles over the cap, listed by title only.
  const capped = new Set<string>()
  let identityChars = 0
  for (const c of profiles) {
    if (legacy(c)) continue
    const full = fullLine(c)
    if (identityChars + full.length > IDENTITY_MAX_CHARS) { capped.add(c.id); continue }
    identityChars += full.length + 1
  }

  const systemLines: string[] = []
  if (systemRules.length > 0) {
    const versionTag = opts.version ? ` v${opts.version}` : ''
    systemLines.push(`## EML System Rules (managed by engramprotocol${versionTag})`)
    for (const r of systemRules) systemLines.push(`- [${r.category}] ${r.text}`)
  }

  // The overflow ladder (see "Size budget"): the order in which entries give
  // way — to title + id (well-formed entries only), then out of the boot.
  const longestFirst = (list: EngramRow[]) => list.map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.content.length - a.c.content.length || b.i - a.i).map(({ c }) => c)
  const ladder: EngramRow[] = [
    ...[...situational].reverse(),
    ...longestFirst(always),
    ...profiles.slice(CORE_PROFILES_KEPT).reverse(),
  ]

  const assemble = (titleOnly: Set<string>, leftOut: Set<string>): string => {
    const short = (c: EngramRow) => legacy(c) || capped.has(c.id) || titleOnly.has(c.id)
    const shown = (list: EngramRow[]) => list.filter(c => !leftOut.has(c.id))
    const lines: string[] = [`# EML Boot — ${agentId}`, '']
    const identity = shown(profiles)
    if (identity.length > 0) {
      lines.push('## Identity', ...identity.map(c => short(c) ? titleOnlyLine(c) : fullLine(c)), '')
    }
    const alwaysShown = shown(always)
    if (alwaysShown.length > 0) {
      lines.push('## Rules (always)', ...alwaysShown.map(c => short(c) ? titleOnlyLine(c) : fullLine(c)), '')
    }
    const situationalShown = shown(situational)
    if (situationalShown.length > 0) {
      lines.push('## Rules (situational — eml_get <id> when the trigger applies)')
      for (const c of situationalShown) {
        lines.push(short(c) ? titleOnlyLine(c) : `- **${entryMeta(c)}** when: ${c.properties?.trigger} · ${c.id}`)
      }
      lines.push('')
    }
    if (systemLines.length > 0) lines.push(...systemLines, '')
    const all = [...identity, ...alwaysShown, ...situationalShown]
    const overflow = all.filter(c => !legacy(c) && (capped.has(c.id) || titleOnly.has(c.id))).length
    const legacyShown = all.filter(legacy).length
    const footer: string[] = []
    if (leftOut.size > 0 && overflow > 0) {
      footer.push(`${overflow} entries listed by title only and ${leftOut.size} left out to fit the boot's size budget — eml_get <id> for the full text, eml_list type=rule for the ones left out.`)
    } else if (leftOut.size > 0) {
      // Only legacy entries gave way (they are title-only already): no "0 listed by title only".
      footer.push(`${leftOut.size} entries left out to fit the boot's size budget — eml_list type=rule for the ones left out.`)
    } else if (overflow > 0) {
      footer.push(`${overflow} entries listed by title only to fit the boot's size budget — eml_get <id> for the full text.`)
    }
    if (legacyShown > 0) {
      footer.push(`${legacyShown} entries are in the old long format and listed by title only — eml_get <id> for the full text (always-rules among them stay binding).`)
    }
    if (footer.length > 0) lines.push('---', ...footer)
    return lines.join('\n').trimEnd()
  }

  const titleOnly = new Set<string>()
  const leftOut = new Set<string>()
  let markdown = assemble(titleOnly, leftOut)
  let budgetReport: BootBudgetReport | undefined
  if (opts.budget !== undefined) {
    const limit = opts.budget
    for (const c of ladder.filter(c => !legacy(c) && !capped.has(c.id))) {
      if (markdown.length <= limit) break
      titleOnly.add(c.id)
      markdown = assemble(titleOnly, leftOut)
    }
    for (const c of ladder) {
      if (markdown.length <= limit) break
      leftOut.add(c.id)
      markdown = assemble(titleOnly, leftOut)
    }
    const count = (list: EngramRow[]) => list.filter(c => titleOnly.has(c.id) && !leftOut.has(c.id)).length
    budgetReport = {
      limit,
      chars: markdown.length,
      situational_title_only: count(situational),
      always_title_only: count(always),
      profiles_title_only: count(profiles),
      left_out: leftOut.size,
      fits: markdown.length <= limit,
    }
  }

  // Counters retained for BootResult consumers; not rendered in the boot (open
  // tasks and logs are recall-only; stale status and overdue reviews belong to
  // the brain-hygiene check).
  const openTasks = eml.engrams
    .query({ type: 'task', limit: 100, order_by: 'updated_at' })
    .filter((t: EngramRow) => t.status === 'planned' || t.status === 'active')
    .sort(
      (a: EngramRow, b: EngramRow) =>
        (PRIORITY_RANK[b.properties?.priority] || 0) - (PRIORITY_RANK[a.properties?.priority] || 0),
    )
    .slice(0, 5)
  const recentLogs = eml.engrams.query({ type: 'log', limit: 3, order_by: 'created_at' })

  const reviewThresholdMs = Date.now() - reviewDays * 86400 * 1000
  const staleStatus = eml.engrams
    .query({ type: 'status', status: 'active', limit: 100 })
    .filter((s: EngramRow) => new Date(s.updated_at).getTime() < reviewThresholdMs)

  const nowIso = new Date().toISOString()
  const overdueReview = eml.engrams
    .query({ limit: 1000, status: 'active' })
    .filter((e: EngramRow) => {
      if (!['decision', 'rule', 'profile'].includes(e.type)) return false
      const due = e.properties && e.properties.review_due_at
      return typeof due === 'string' && due < nowIso
    })

  const result: BootResult = {
    agent: agentId,
    engrams: profiles.length + always.length + situational.length,
    open_tasks: openTasks.length,
    recent_logs: recentLogs.length,
    stale_status: staleStatus.length,
    overdue_review: overdueReview.length,
    legacy: legacyCount,
    markdown,
  }
  if (opts.version) result.version = opts.version
  if (budgetReport) result.budget = budgetReport
  return result
}
