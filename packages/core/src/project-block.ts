import type { EML } from './index'
import type { Engram } from './types'
import { REVIEW_LABEL } from './engrams'
import { previewText, SHOW_PREVIEW_CHARS } from './render'
import { isLegacyFormat } from './validate'

// --- The project block ---------------------------------------------------------
//
// Model: note rule-delivery-model-draft (points 1, 2, 5, 7). The boot carries
// what holds in every session (global, agent.<self>, user.<self>); the project
// block carries one project: its state, its open work and ALL its rules —
// including the rules of its parent projects, marked inherited. A host that
// knows the session's project (the EML cockpit) injects it on the first prompt
// of a session and again after a compaction (mcp-server hooks/project-block.ts).
//
//   Status        — the active status: state, preview, next step.
//   Open tasks    — the first TASKS_SHOWN by priority, title + preview; the rest
//                   as a count.
//   Latest session — the newest log: title + id.
//   Rules situational — title + trigger + id; eml_get when the trigger applies.
//   Rules always  — in full, last, so they sit right before the prompt.
//   Hints         — pending reviews, legacy entries, what gave way to the budget.
//
// No decisions: they hang on their tasks. Rules are short at the source
// (validate.ts), so nothing is cut mid-text: an entry is shown whole or by
// title + id. Legacy rules (written before the short format) are shown by
// title + id, as in the boot.
//
// Every field the block reads from an engram's properties is read in this file
// only (fields below), so a change of the engram model touches one place.

const TASKS_SHOWN = 10
const TASK_PREVIEW_CHARS = 100
const MAX_PARENT_DEPTH = 5

type Row = Engram & { properties?: Record<string, any> | null }

const fields = {
  applies: (r: Row) => r.properties?.applies as string | undefined,
  trigger: (r: Row) => r.properties?.trigger as string | undefined,
  priority: (t: Row) => (t.properties?.priority as string | undefined) ?? 'normal',
  stage: (t: Row) => t.properties?.stage as string | undefined,
  assignee: (t: Row) => t.properties?.assignee_id as string | undefined,
  state: (s: Row) => s.properties?.state as string | undefined,
  nextStep: (s: Row) => s.properties?.next_step as string | undefined,
}

export interface ProjectBlockOptions {
  /**
   * Hard cap for `markdown`, in characters (string length) — the limit of the
   * harness and output form the caller serves, as for the boot (boot.ts, "Size
   * budget"). Omitted: unbounded.
   */
  budget?: number
}

export interface ProjectBlockBudgetReport {
  limit: number
  chars: number
  /** Shown tasks listed by title only (preview dropped). */
  tasks_title_only: number
  /** Tasks moved from the list into the "more open tasks" count. */
  tasks_left_out: number
  /** True when the latest-session line was left out. */
  log_left_out: boolean
  /** Situational rules listed by title only (trigger dropped). */
  situational_title_only: number
  /** Always-rules listed by title only. */
  always_title_only: number
  /** Rules left out entirely because even title + id was over the limit. */
  rules_left_out: number
  /** False only when the header and status alone are over the limit. */
  fits: boolean
}

export interface ProjectBlockResult {
  scope: string
  markdown: string
  /** All open tasks of the project (shown or counted). */
  open_tasks: number
  pending_reviews: number
  /** Rules of the project and its parents in the old long format (shown by title only). */
  legacy: number
  budget?: ProjectBlockBudgetReport
}

/**
 * The project and its parents, nearest first: ['project.app', 'project.eml'].
 * Stops at an unknown parent, a cycle or MAX_PARENT_DEPTH parents.
 */
export function projectScopeChain(eml: EML, projectId: string): string[] {
  const chain: string[] = []
  let id: string | null = projectId
  while (id && !chain.includes(`project.${id}`) && chain.length <= MAX_PARENT_DEPTH) {
    const project = eml.projects.get(id)
    if (!project) break
    chain.push(`project.${id}`)
    id = project.parent_project
  }
  return chain
}

/** The active rules of a project's parents (nearest parent first, by title within one). */
export function inheritedRules(eml: EML, scope: string): Engram[] {
  if (!scope.startsWith('project.')) return []
  return projectScopeChain(eml, scope.slice('project.'.length)).slice(1).flatMap(rulesOf(eml))
}

const rulesOf = (eml: EML) => (scope: string): Row[] =>
  (eml.engrams.query({ type: 'rule', scope, status: 'active', limit: 1000 }) as Row[])
    .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''))

/** The project block for project.<id>, or null when no such project exists. */
export function projectBlock(eml: EML, projectId: string, opts: ProjectBlockOptions = {}): ProjectBlockResult | null {
  const project = eml.projects.get(projectId)
  if (!project) return null
  const scope = `project.${projectId}`
  const state = eml.engrams.buildBrainState(scope)

  const openTasks = eml.engrams.query({ type: 'task', scope, statuses: ['planned', 'active'], limit: 10000 }).length
  const tasks = (state.open_tasks as Row[]).slice(0, TASKS_SHOWN)
  const log = state.recent_logs[0] as Row | undefined
  const pendingReviews = eml.engrams
    .query({ scope, label: REVIEW_LABEL, statuses: ['active', 'planned'], limit: 10000 })
    .filter(e => e.status === 'active' || e.type === 'task').length

  const rules = projectScopeChain(eml, projectId).flatMap(rulesOf(eml))
  const always = rules.filter(r => fields.applies(r) === 'always')
  const situational = rules.filter(r => fields.applies(r) !== 'always')
  const legacy = (r: Row) => isLegacyFormat('rule', r.content, r.properties)
  const legacyCount = rules.filter(legacy).length

  const inherited = (r: Row) => (r.scope === scope ? '' : ` (inherited from ${r.scope})`)
  const titleOnlyRule = (r: Row) => `- ${r.title ?? '(untitled)'}${inherited(r)} · ${r.id}`
  const taskMeta = (t: Row) => {
    const stage = fields.stage(t) ? `·${fields.stage(t)}` : ''
    const assignee = fields.assignee(t) ? ` → ${fields.assignee(t)}` : ''
    return `- [${fields.priority(t)}·${t.status}${stage}]${assignee} ${t.title ?? '(untitled)'}`
  }

  const header: string[] = [`# Project — ${scope} (${project.name})`, 'The rules below are binding while you work in this project.', '']
  const statusLines = (state.current_status as Row[]).map(s => {
    const st = fields.state(s) ? `[${fields.state(s)}] ` : ''
    const next = fields.nextStep(s) ? ` · next: ${fields.nextStep(s)}` : ''
    return `- ${st}${previewText(s.content, SHOW_PREVIEW_CHARS)}${next} · ${s.id}`
  })

  interface Shrink { tasksTitleOnly: number, tasksLeftOut: number, logLeftOut: boolean, titleOnly: Set<string>, leftOut: Set<string> }

  const assemble = (k: Shrink): string => {
    const lines = [...header]
    if (statusLines.length > 0) lines.push('## Status', ...statusLines, '')

    const shownTasks = tasks.slice(0, tasks.length - k.tasksLeftOut)
    if (openTasks > 0) {
      lines.push(`## Open tasks (${openTasks})`)
      shownTasks.forEach((t, i) => lines.push(i >= shownTasks.length - k.tasksTitleOnly
        ? `${taskMeta(t)} · ${t.id}`
        : `${taskMeta(t)} — ${previewText(t.content, TASK_PREVIEW_CHARS)} · ${t.id}`))
      const more = openTasks - shownTasks.length
      if (more > 0) lines.push(`- ${more} ${shownTasks.length > 0 ? 'more ' : ''}open tasks — eml_list type=task scope=${scope} status=planned (or active)`)
      lines.push('')
    }

    if (log && !k.logLeftOut) lines.push('## Latest session', `- ${log.title ?? '(untitled)'} · ${log.id}`, '')

    const short = (r: Row) => legacy(r) || k.titleOnly.has(r.id)
    const sitShown = situational.filter(r => !k.leftOut.has(r.id))
    if (sitShown.length > 0) {
      lines.push('## Rules (situational — eml_get <id> when the trigger applies)')
      for (const r of sitShown) {
        lines.push(short(r) || !fields.trigger(r)
          ? titleOnlyRule(r)
          : `- **${r.title ?? '(untitled)'}**${inherited(r)} when: ${fields.trigger(r)} · ${r.id}`)
      }
      lines.push('')
    }
    const alwaysShown = always.filter(r => !k.leftOut.has(r.id))
    if (alwaysShown.length > 0) {
      lines.push('## Rules (always)')
      for (const r of alwaysShown) {
        lines.push(short(r) ? titleOnlyRule(r) : `- **${r.title ?? '(untitled)'}**${inherited(r)} ${r.content}`)
      }
      lines.push('')
    }

    const hints: string[] = []
    if (pendingReviews > 0) hints.push(`- ${pendingReviews} engrams in this project are due for review.`)
    const legacyShown = [...sitShown, ...alwaysShown].filter(legacy).length
    if (legacyShown > 0) {
      hints.push(`- ${legacyShown} rules are in the old long format and listed by title only — eml_get <id> for the full text (always-rules among them stay binding).`)
    }
    const overflow = k.tasksTitleOnly + k.tasksLeftOut + (k.logLeftOut ? 1 : 0)
      + [...k.titleOnly].filter(id => !k.leftOut.has(id)).length + k.leftOut.size
    if (overflow > 0) {
      hints.push(`- ${overflow} entries shortened or left out to fit the block's size budget — eml_show ${scope} for the full picture.`)
    }
    if (hints.length > 0) lines.push('## Hints', ...hints, '')
    return lines.join('\n').trimEnd()
  }

  // The overflow ladder (model point 5), one whole entry at a time: task
  // previews (from the last task), tasks into the count, the log line, then
  // situational triggers (from the last), always-rules by title only (longest
  // first), and as a last resort rules left out in the same order.
  const k: Shrink = { tasksTitleOnly: 0, tasksLeftOut: 0, logLeftOut: false, titleOnly: new Set(), leftOut: new Set() }
  let markdown = assemble(k)
  let report: ProjectBlockBudgetReport | undefined
  if (opts.budget !== undefined) {
    const limit = opts.budget
    const longestFirst = [...always].sort((a, b) => b.content.length - a.content.length)
    const ruleLadder = [...[...situational].reverse(), ...longestFirst]
    // Tasks give way from the last: first the preview, then into the count
    // (the tasks still listed keep their title-only form).
    const steps: Array<() => void> = [
      ...tasks.map((_, i) => () => { k.tasksTitleOnly = i + 1 }),
      ...tasks.map((_, i) => () => { k.tasksLeftOut = i + 1; k.tasksTitleOnly = tasks.length - i - 1 }),
      ...(log ? [() => { k.logLeftOut = true }] : []),
      ...ruleLadder.filter(r => !legacy(r)).map(r => () => { k.titleOnly.add(r.id) }),
      ...ruleLadder.map(r => () => { k.leftOut.add(r.id) }),
    ]
    for (const step of steps) {
      if (markdown.length <= limit) break
      step()
      markdown = assemble(k)
    }
    const titleOnlyOf = (list: Row[]) => list.filter(r => k.titleOnly.has(r.id) && !k.leftOut.has(r.id)).length
    report = {
      limit,
      chars: markdown.length,
      tasks_title_only: k.tasksTitleOnly,
      tasks_left_out: k.tasksLeftOut,
      log_left_out: k.logLeftOut,
      situational_title_only: titleOnlyOf(situational),
      always_title_only: titleOnlyOf(always),
      rules_left_out: k.leftOut.size,
      fits: markdown.length <= limit,
    }
  }

  const result: ProjectBlockResult = { scope, markdown, open_tasks: openTasks, pending_reviews: pendingReviews, legacy: legacyCount }
  if (report) result.budget = report
  return result
}
