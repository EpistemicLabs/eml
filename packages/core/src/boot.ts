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
  /** False when even every fallback is over the limit (the markdown is still returned). */
  fits: boolean
}

// --- What boots ----------------------------------------------------------------
//
// Model: note rule-delivery-model-draft. The boot carries the rules and the
// identity of the scopes that hold for every session — global, agent.<self>,
// user.<self> — and nothing of a project (the project block brings those).
// Selection is by scope; properties.boot is no longer read.
//
//   System rules  — the protocol's own (ALL_RULES), always whole.
//   Identity      — the core profiles: per agent.<self> and user.<self> the one
//                   titled <id> or <id>-identity. Block capped at
//                   IDENTITY_MAX_CHARS; other profiles stay out of the boot.
//   Rules always  — in full: binding within their scope and delivered unasked.
//   Rules situational — an index of title + trigger + id; the agent fetches the
//                   rule with eml_get when the trigger applies.
//   Hints         — short system signals (legacy entries, overflow).
//
// Rules and profiles are short at the source (validate.ts, formatProblems), so
// nothing is ever cut mid-text: an entry is shown whole or by title only.
// Legacy entries (written before the format) are shown by title only and
// counted in the hints.

const IDENTITY_MAX_CHARS = 1_500

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
// What gives way until the markdown fits: situational rules, from the last
// one, are listed by title only (the trigger dropped). System rules, identity
// and always-rules are never dropped — when they alone are over the limit, the
// markdown is returned anyway and the report says fits=false (the hook logs it).

function entryMeta(c: EngramRow): string {
  return `[${c.scope} | ${c.title || '(untitled)'}]`
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
  const identityLines: string[] = []
  let identityTitleOnly = 0
  let identityChars = 0
  for (const c of profiles) {
    const full = `- **${entryMeta(c)}** ${c.content}`
    if (legacy(c)) { identityLines.push(titleOnlyLine(c)); continue }
    if (identityChars + full.length > IDENTITY_MAX_CHARS) { identityLines.push(titleOnlyLine(c)); identityTitleOnly++; continue }
    identityLines.push(full)
    identityChars += full.length + 1
  }

  const alwaysLines = always.map((c: EngramRow) => legacy(c) ? titleOnlyLine(c) : `- **${entryMeta(c)}** ${c.content}`)

  const systemLines: string[] = []
  if (systemRules.length > 0) {
    const versionTag = opts.version ? ` v${opts.version}` : ''
    systemLines.push(`## EML System Rules (managed by engramprotocol${versionTag})`)
    for (const r of systemRules) systemLines.push(`- [${r.category}] ${r.text}`)
    systemLines.push('')
  }

  // The situational index is the only part that varies with the budget: the
  // last `titleOnly` of its well-formed entries lose their trigger.
  const formed = situational.filter((c: EngramRow) => !legacy(c))
  const assemble = (titleOnly: number): string => {
    const dropped = new Set(formed.slice(formed.length - titleOnly).map((c: EngramRow) => c.id))
    const lines: string[] = [`# EML Boot — ${agentId}`, '', ...systemLines]
    if (identityLines.length > 0) lines.push('## Identity', ...identityLines, '')
    if (alwaysLines.length > 0) lines.push('## Rules (always)', ...alwaysLines, '')
    if (situational.length > 0) {
      lines.push('## Rules (situational — eml_get <id> when the trigger applies)')
      for (const c of situational) {
        lines.push(legacy(c) || dropped.has(c.id)
          ? titleOnlyLine(c)
          : `- **${entryMeta(c)}** when: ${c.properties?.trigger} · ${c.id}`)
      }
      lines.push('')
    }
    const hints: string[] = []
    if (legacyCount > 0) {
      hints.push(`- ${legacyCount} rules/profiles in the old long format are listed by title only — shorten them (rule ≤ 200, profile ≤ 400, situational needs a trigger).`)
    }
    const overflow = identityTitleOnly + titleOnly
    if (overflow > 0) hints.push(`- ${overflow} entries listed by title only to fit the boot's size budget.`)
    if (hints.length > 0) lines.push('## Hints', ...hints, '')
    lines.push(
      '---',
      '_For decisions, statuses, open tasks, logs, project-specific rules: call eml_recall <topic> or eml_show <id>._',
    )
    return lines.join('\n')
  }

  let markdown = assemble(0)
  let budgetReport: BootBudgetReport | undefined
  if (opts.budget !== undefined) {
    const limit = opts.budget
    let titleOnly = 0
    while (markdown.length > limit && titleOnly < formed.length) markdown = assemble(++titleOnly)
    budgetReport = { limit, chars: markdown.length, situational_title_only: titleOnly, fits: markdown.length <= limit }
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
