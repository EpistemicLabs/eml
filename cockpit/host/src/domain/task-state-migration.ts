import type { DelegationFields } from './delegation.js'
import type { Wait } from './task-waits.js'
import { waitsOf } from './task-waits.js'

/**
 * The migration of existing tasks to the task state model (brain schema 23; decision task-state-migration-rules). The brain's own migration (v0.23_migrate.sql) did the mechanical part: delegation from
 * delegate and checkpoint (never with a request), waits from waiting_on. This plans what needs the cockpit's rules,
 * per task, and lists it as a dry run before anything is written:
 *
 *   - a delegate without a checkpoint → delegation { agent, checkpoint: after }
 *     without a request: nothing starts; the board offers "Hand to <agent>";
 *   - a checkpoint without a delegate → cleared;
 *   - a planned task with a delegate and a checkpoint, no request and no schedule (its schedule would start it) — one the runner starts today →
 *     requested now, so it starts as before. Only in a space the migration has not run in yet: afterwards a task like
 *     that is one the migration gave its checkpoint (or one handed over without a start), and a second run would
 *     start it;
 *   - blockers → one wait of kind outside per blocker, on the owner: the person keeping an eye on it, not the one to
 *     act (task-turn.ts isViewersMove), so it never lands in Needs you;
 *   - intent → appended to the goal where it says something the goal does not (the text is in the dry run);
 *   - a snooze in this cockpit's store → snoozed_until on the task's wait.
 *
 * Done elsewhere and listed here: the held waits of held-waits.json (adopted at the host's start) and the live
 * sessions on tasks (application/run-records.ts). The jobs of before brain schema 24 are not this migration's: they
 * move onto their tasks at the host's start (domain/job-migration.ts), one without a task getting a task of its own.
 */

export interface MigrationTask {
  id: string
  status: string
  title: string
  properties?: {
    assignee_ids?: string[]
    delegate?: string
    checkpoint?: string
    delegation?: DelegationFields
    goal?: string
    intent?: string
    blockers?: string[]
    waits?: unknown
    waiting_on?: unknown
  }
}

export interface MigrationInput {
  tasks: MigrationTask[]
  /** This cockpit's snoozes (task-commands.json), keyed task:<id>@<since>. */
  snoozes: ReadonlyArray<{ key: string; until: string }>
  /** Tasks with waits in held-waits.json. */
  heldWaitTasks: ReadonlyArray<{ taskId: string; count: number }>
  /** Sessions on tasks, open now: a run each. */
  liveSessions: ReadonlyArray<{ sessionId: string; taskId: string }>
  /** The viewer, who owns a task without an owner's wait. */
  viewer: string
  /** The migration's time (ISO): the requests it gives. */
  now: string
  /** When the migration ran in this space before (its marker in the brain), or null: then it gives no requests. */
  ranBefore?: string | null
}

export type MigrationRule = 'checkpoint_after' | 'checkpoint_cleared' | 'requested' | 'blockers' | 'intent' | 'snooze'

/** One task's change in the brain: the fields to write in one track call, and the journal line. */
export interface TaskChange {
  taskId: string
  title: string
  rules: MigrationRule[]
  patch: Record<string, unknown>
  /** What changes, one line per rule, for the dry run and the journal. */
  lines: string[]
}

export interface MigrationPlan {
  changes: TaskChange[]
  /** Done by the cockpit on its own (listed for the dry run). */
  elsewhere: {
    heldWaits: ReadonlyArray<{ taskId: string; count: number }>
    runs: ReadonlyArray<{ sessionId: string; taskId: string }>
  }
}

const OPEN = new Set(['planned', 'active'])
const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

/** The goal with the intent added where it says something the goal does not; null when nothing changes. */
export function goalWithIntent(goal: string | undefined, intent: string): string | null {
  const i = intent.trim()
  if (!i) return null
  if (!goal?.trim()) return i
  if (norm(goal).includes(norm(i))) return null
  return `${goal.trim().replace(/\.?$/, '.')} Why: ${i.replace(/\.?$/, '.')}`
}

export function planTaskStateMigration(input: MigrationInput): MigrationPlan {
  const changes: TaskChange[] = []
  const snoozesByTask = new Map<string, Array<{ since: string; until: string }>>()
  for (const s of input.snoozes) {
    const m = /^task:([^@]+)@(.*)$/.exec(s.key)
    if (m) snoozesByTask.set(m[1], [...(snoozesByTask.get(m[1]) ?? []), { since: m[2], until: s.until }])
  }

  for (const task of input.tasks) {
    if (!OPEN.has(task.status)) continue
    const p = task.properties ?? {}
    const rules: MigrationRule[] = []
    const lines: string[] = []
    const patch: Record<string, unknown> = {}
    let delegation: DelegationFields | null = p.delegation ?? (p.delegate ? { agent: p.delegate, ...(p.checkpoint ? { checkpoint: p.checkpoint } : {}) } : null)
    let waits: Wait[] = waitsOf(p)
    let waitsChanged = false

    if (p.delegate && !p.checkpoint) {
      delegation = { ...delegation!, agent: p.delegate, checkpoint: 'after' }
      rules.push('checkpoint_after')
      lines.push(`handed to ${p.delegate} with checkpoint after, not started: the board offers "Hand to ${p.delegate}"`)
    } else if (!p.delegate && p.checkpoint) {
      patch.checkpoint = null
      rules.push('checkpoint_cleared')
      lines.push(`checkpoint ${p.checkpoint} cleared: no agent is delegated`)
    } else if (!input.ranBefore && task.status === 'planned' && p.delegate && p.checkpoint && !delegation?.requested_at && !delegation?.schedule) {
      delegation = { ...delegation!, requested_at: input.now }
      rules.push('requested')
      lines.push(`requested now, so the runner starts ${p.delegate} as before`)
    }

    const blockers = (p.blockers ?? []).filter((b) => typeof b === 'string' && b.trim() !== '')
    if (blockers.length > 0) {
      const who = p.assignee_ids?.[0] ?? input.viewer
      blockers.forEach((why, i) => {
        const id = `blocker-${i + 1}`
        if (!waits.some((w) => w.id === id)) waits = [...waits, { id, who, kind: 'outside', why, since: input.now }]
      })
      waitsChanged = true
      patch.blockers = null
      rules.push('blockers')
      lines.push(`blockers → ${blockers.length} outside wait${blockers.length === 1 ? '' : 's'} on ${who}: ${blockers.map((b) => `"${b}"`).join(', ')}`)
    }

    if (typeof p.intent === 'string' && p.intent.trim()) {
      const goal = goalWithIntent(p.goal, p.intent)
      if (goal !== null) {
        patch.goal = goal
        lines.push(`intent folded into the goal: "${goal}"`)
      } else {
        lines.push('intent cleared: the goal already says it')
      }
      patch.intent = null
      rules.push('intent')
    }

    for (const s of snoozesByTask.get(task.id) ?? []) {
      if (Date.parse(s.until) <= Date.parse(input.now)) continue
      let hit = false
      waits = waits.map((w) => {
        if (w.who !== input.viewer || (s.since !== '' && (w.since ?? '') !== s.since) || w.snoozed_until) return w
        hit = true
        return { ...w, snoozed_until: s.until }
      })
      if (hit) {
        waitsChanged = true
        if (!rules.includes('snooze')) rules.push('snooze')
        lines.push(`parked until ${s.until} (a snooze on this cockpit)`)
      }
    }

    if (rules.length === 0) continue
    if (rules.includes('checkpoint_after') || rules.includes('requested')) patch.delegation = delegation
    if (waitsChanged) patch.waits = waits.length > 0 ? waits : null
    changes.push({ taskId: task.id, title: task.title, rules, patch, lines })
  }

  return {
    changes,
    elsewhere: {
      heldWaits: input.heldWaitTasks,
      runs: input.liveSessions,
    },
  }
}

const RULE_TITLES: Record<MigrationRule, string> = {
  checkpoint_after: 'A delegate without a checkpoint → checkpoint after, no request (nothing starts)',
  checkpoint_cleared: 'A checkpoint without a delegate → cleared',
  requested: 'Planned with a delegate and a checkpoint → requested now (starts as before)',
  blockers: 'Blockers → outside waits',
  intent: 'Intent → folded into the goal',
  snooze: 'A snooze on this cockpit → parked wait',
}

/** The plan as the dry run's Markdown: per rule, every task it touches, then what the cockpit does on its own. */
export function migrationReport(plan: MigrationPlan, opts: { space: string; at: string; ranBefore?: string | null }): string {
  const out: string[] = [`# Task state migration — dry run`, '', `Space: ${opts.space} · ${opts.at} · nothing written.`, '']
  if (opts.ranBefore) out.push(`The migration ran in this space on ${opts.ranBefore}: it gives no start requests again.`, '')
  out.push(`${plan.changes.length} task${plan.changes.length === 1 ? '' : 's'} change in the brain, one journal line each.`, '')
  for (const rule of Object.keys(RULE_TITLES) as MigrationRule[]) {
    const hit = plan.changes.filter((c) => c.rules.includes(rule))
    out.push(`## ${RULE_TITLES[rule]} (${hit.length})`, '')
    if (hit.length === 0) out.push('None.', '')
    for (const c of hit) {
      const line = c.lines.find((l) => lineRule(l) === rule) ?? c.lines[0]
      out.push(`- ${c.title} (${c.taskId.slice(0, 8)}): ${line}`)
    }
    if (hit.length > 0) out.push('')
  }
  const e = plan.elsewhere
  out.push('## Done by the cockpit on its own', '')
  out.push(`- Held waits (held-waits.json) → the tasks' waits (${e.heldWaits.length} task${e.heldWaits.length === 1 ? '' : 's'})`)
  out.push(`- Sessions open on tasks → a run each (${e.runs.length})`)
  return `${out.join('\n')}\n`
}

const lineRule = (line: string): MigrationRule | null =>
  line.startsWith('handed to') ? 'checkpoint_after'
    : line.startsWith('checkpoint ') ? 'checkpoint_cleared'
      : line.startsWith('requested now') ? 'requested'
        : line.startsWith('blockers') ? 'blockers'
          : line.startsWith('intent') ? 'intent'
            : line.startsWith('parked') ? 'snooze' : null
