import type { EML } from './index'
import type { SystemRule } from './system-rules'

type EngramRow = Record<string, any>

export interface BootResult {
  agent: string
  engrams: number
  open_tasks: number
  recent_logs: number
  stale_status: number
  overdue_review: number
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
   * Hard cap for `markdown`, in characters (string length). The caller passes
   * the limit of the harness and output form it serves — see "Size budget"
   * below. Omitted: unbounded (tests, CLI).
   */
  budget?: number
}

export interface BootBudgetReport {
  /** The cap that was applied. */
  limit: number
  /** `markdown.length` after trimming. */
  chars: number
  /** Per-rule content cut-off that was applied (the ladder's rung). */
  rule_cap: number
  /** Behavior rules rendered as scope | title + id only. */
  rules_named_only: number
  /** Profiles rendered as scope | title + id only. */
  profiles_named_only: number
  /** False when even the last rung is over the limit (the markdown is still returned). */
  fits: boolean
}

// v0.10.1: only profile (rendered as Identity) and rule (rendered as
// Behavior) are emitted as type-sections. Decision/status/task/log/event/
// reference/note are recall-only — including them blows past Claude Code's
// 10 KB inline limit for SessionStart-Hook stdout (anything larger gets
// persisted to file and only a 2 KB preview reaches the model).
const TYPE_LABELS: Record<string, string> = {
  profile: 'Identity',
  rule: 'Behavior',
}

const PRIORITY_RANK: Record<string, number> = { urgent: 4, high: 3, normal: 2, low: 1 }

// Rule-content trimmer: a rule's body is cut at `cap` chars (600 without a
// budget — the pre-budget behaviour, kept so a small brain renders exactly as
// before). Profile content is not trimmed on this path (identity stays full).
const RULE_CONTENT_MAX_CHARS = 600

function trimRuleContent(content: unknown, cap: number = RULE_CONTENT_MAX_CHARS): string {
  if (typeof content !== 'string') return String(content)
  if (content.length <= cap) return content
  return content.slice(0, cap) + '…'
}

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
// the harness and output form it serves (decision boot-budget-per-harness),
// and boot() guarantees the markdown fits.
//
// What gives way, in this order (the ladder), until the markdown fits:
//   1. behavior rules are shortened evenly: body cut at 600 → 400 → 250 chars;
//   2. behavior rules, from the last one, are listed as scope | title + id only;
//   3. profiles the same way.
// The header, the system rules and the footer are never cut: the rules are
// product surface, the footer tells the agent where the rest is (and, when
// trimmed, that eml_get <id> returns the full text). Rules carry no rank, so
// "from the last one" follows the store order — a rule's place in the boot is
// not a statement about its weight (task boot-rendering-of-rules-and-identity).
const RULE_CAP_LADDER = [RULE_CONTENT_MAX_CHARS, 400, 250]

interface TrimPlan {
  ruleCap: number
  rulesNamedOnly: number
  profilesNamedOnly: number
}

function* trimPlans(rules: number, profiles: number): Generator<TrimPlan> {
  for (const ruleCap of RULE_CAP_LADDER) yield { ruleCap, rulesNamedOnly: 0, profilesNamedOnly: 0 }
  const floor = RULE_CAP_LADDER[RULE_CAP_LADDER.length - 1]
  for (let k = 1; k <= rules; k++) yield { ruleCap: floor, rulesNamedOnly: k, profilesNamedOnly: 0 }
  for (let k = 1; k <= profiles; k++) yield { ruleCap: floor, rulesNamedOnly: rules, profilesNamedOnly: k }
}

function entryMeta(c: EngramRow): string {
  const meta = [c.scope]
  if (c.title) meta.push(c.title)
  return `**[${meta.join(' | ')}]**`
}

function namedOnlyLine(c: EngramRow): string {
  return `- ${entryMeta(c)} _(full text: eml_get ${c.id})_`
}

export function boot(eml: EML, agentId: string, opts: BootOptions = {}): BootResult {
  const reviewDays = opts.reviewDays ?? 14
  const systemRules = opts.systemRules ?? []

  const bootEngrams = eml.engrams
    .query({ limit: 10000, status: 'active' })
    .filter((c: EngramRow) => {
      if (!c.properties || !c.properties.boot) return false
      const bootArr = Array.isArray(c.properties.boot) ? c.properties.boot : [c.properties.boot]
      return bootArr.includes(agentId) || bootArr.includes('*')
    })

  const grouped: Record<string, EngramRow[]> = {}
  for (const c of bootEngrams) {
    const t = c.type as string
    if (!grouped[t]) grouped[t] = []
    grouped[t].push(c)
  }

  // The DB sections (Identity, Behavior) are the only variable part; they are
  // rendered per trim plan, the rest once.
  const profiles = grouped['profile'] ?? []
  const rules = grouped['rule'] ?? []

  const renderSections = (plan: TrimPlan): string[] => {
    const lines: string[] = [`# EML Boot — ${agentId}`, '']
    const sections: Array<[string, EngramRow[], number]> = [
      [TYPE_LABELS.profile, profiles, plan.profilesNamedOnly],
      [TYPE_LABELS.rule, rules, plan.rulesNamedOnly],
    ]
    for (const [label, entries, namedOnly] of sections) {
      if (entries.length === 0) continue
      lines.push(`## ${label}`)
      const firstNamed = entries.length - namedOnly
      entries.forEach((c, i) => {
        if (i >= firstNamed) lines.push(namedOnlyLine(c))
        else if (label === TYPE_LABELS.rule) lines.push(`- ${entryMeta(c)} ${trimRuleContent(c.content, plan.ruleCap)}`)
        else lines.push(`- ${entryMeta(c)} ${c.content}`)
      })
      lines.push('')
    }
    return lines
  }

  // Code rules section last (BEHAVIOR_DEFAULTS + SYSTEM_RULES, passed via
  // opts.systemRules from server.ts as ALL_RULES).
  const systemLines: string[] = []
  if (systemRules.length > 0) {
    const versionTag = opts.version ? ` v${opts.version}` : ''
    systemLines.push(`## EML System Rules (managed by engramprotocol${versionTag})`)
    for (const r of systemRules) systemLines.push(`- [${r.category}] ${r.text}`)
    systemLines.push('')
  }

  // Footer hint pointing to recall for everything not in the slim boot; when
  // the budget trimmed something, it also says so and how to get the full text.
  const footer = (plan: TrimPlan, trimmed: boolean): string[] => {
    const out = [
      '---',
      '_For decisions, statuses, open tasks, logs, project-specific rules: call eml_recall <topic> or eml_show <id>._',
    ]
    if (trimmed) {
      const parts: string[] = []
      if (plan.ruleCap < RULE_CONTENT_MAX_CHARS) parts.push(`behavior rules cut at ${plan.ruleCap} chars`)
      if (plan.rulesNamedOnly > 0) parts.push(`${plan.rulesNamedOnly} rule(s) listed by name only`)
      if (plan.profilesNamedOnly > 0) parts.push(`${plan.profilesNamedOnly} profile(s) listed by name only`)
      out.push(`_Boot trimmed to the hook's size budget: ${parts.join(', ')} — eml_get <id> returns the full text._`)
    }
    return out
  }

  const assemble = (plan: TrimPlan, trimmed: boolean): string =>
    [...renderSections(plan), ...systemLines, ...footer(plan, trimmed)].join('\n')

  let markdown = ''
  let budgetReport: BootBudgetReport | undefined
  if (opts.budget === undefined) {
    markdown = assemble({ ruleCap: RULE_CONTENT_MAX_CHARS, rulesNamedOnly: 0, profilesNamedOnly: 0 }, false)
  } else {
    const limit = opts.budget
    let first = true
    let fits = false
    let plan: TrimPlan = { ruleCap: RULE_CONTENT_MAX_CHARS, rulesNamedOnly: 0, profilesNamedOnly: 0 }
    for (const candidate of trimPlans(rules.length, profiles.length)) {
      plan = candidate
      markdown = assemble(plan, !first)
      if (markdown.length <= limit) { fits = true; break }
      first = false
    }
    budgetReport = {
      limit,
      chars: markdown.length,
      rule_cap: plan.ruleCap,
      rules_named_only: plan.rulesNamedOnly,
      profiles_named_only: plan.profilesNamedOnly,
      fits,
    }
  }

  // Counters retained for BootResult consumers; sections no longer rendered
  // in the slim boot (open tasks, recent logs, stale status, overdue review
  // are all recall-only as of v0.10.1; stale/overdue come back with the
  // v0.11 brain-hygiene cluster).
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
    engrams: bootEngrams.length,
    open_tasks: openTasks.length,
    recent_logs: recentLogs.length,
    stale_status: staleStatus.length,
    overdue_review: overdueReview.length,
    markdown,
  }
  if (opts.version) result.version = opts.version
  if (budgetReport) result.budget = budgetReport
  return result
}
