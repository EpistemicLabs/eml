import type { DelegationFields, ScheduleFields } from './delegation.js'
import { activeGrants, isOpenRun, type ChannelTrigger, type Job, type JobRun } from './job.js'
import { formatInZone, parseAt } from './schedule.js'
import { hasSchedule, nextRunOfSchedule, scheduleOf } from './task-schedule.js'
import type { ToolProfile } from './tool-profile.js'

/**
 * The rules of the schedule tool (application/jobs.ts), each a pure function: which task a key names, what a time
 * in the call is, where a prompt goes in the task's text, how many tasks of a space may hold a schedule, what tools
 * the task's sessions keep, and the few lines an agent reads about a task's schedule.
 *
 * The tool sets a schedule on a task: repeating times and one wake-up (domain/task-schedule.ts). What only this
 * machine needs it keeps on the task's record (domain/job.ts).
 */

export const JOB_ACTIONS = ['create', 'list', 'update', 'pause', 'resume', 'delete', 'run_now', 'finish'] as const
export type JobAction = typeof JOB_ACTIONS[number]

/** A task as the tool reads it from the brain. */
export interface ToolTask {
  id: string
  type?: string
  title?: string | null
  content?: string
  status: string
  scope?: string
  ingested_by?: string | null
  properties?: {
    display_title?: string
    goal?: string
    assignee_ids?: string[]
    delegation?: DelegationFields | null
    delegate?: string
    checkpoint?: string
  } | null
}

const OPEN = new Set(['planned', 'active'])

export const isOpenTask = (task: Pick<ToolTask, 'status'>): boolean => OPEN.has(task.status)

/** The task's name as people read it. */
export const nameOfTask = (task: Pick<ToolTask, 'id' | 'title' | 'properties'>): string => task.properties?.display_title ?? task.title ?? task.id

/** Characters of a task id that name it on their own. */
export const ID_PREFIX = 8

/**
 * The task a key names among a space's open tasks: its id, else the first characters of its id (at least 8), else
 * its exact display title — first among the tasks the tool lists (`listed`: with a schedule or a channel), then among
 * all open ones. `none`: nothing fits; `many`: how many do, so the caller asks for the id.
 */
export function findTask<T extends Pick<ToolTask, 'id' | 'title' | 'properties'>>(tasks: readonly T[], key: string, listed: (task: T) => boolean): T | { none: true } | { many: number } {
  const wanted = key.trim()
  const exact = tasks.find((task) => task.id === wanted)
  if (exact) return exact
  const one = (matches: T[]): T | { many: number } | null => (matches.length === 1 ? matches[0] : matches.length > 1 ? { many: matches.length } : null)
  const byPrefix = wanted.length >= ID_PREFIX ? one(tasks.filter((task) => task.id.startsWith(wanted))) : null
  if (byPrefix) return byPrefix
  const named = tasks.filter((task) => nameOfTask(task).toLowerCase() === wanted.toLowerCase())
  return one(named.filter(listed)) ?? one(named) ?? { none: true }
}

/** What a call's `at` is: the instant (ISO), or why it is not taken. Read in `zone`; at most `maxAheadMs` ahead. */
export function readAt(text: string, zone: string, now: number, maxAheadMs: number): { at: string } | { error: string } {
  const at = parseAt(text, zone)
  if (at === null) return { error: `at: "${text}" is not a date and time; write it like 2026-11-13T10:00 (read in ${zone})` }
  if (at <= now) return { error: `at: ${formatInZone(at, zone)} (${zone}) has passed` }
  if (at - now > maxAheadMs) return { error: 'at: at most a year ahead' }
  return { at: new Date(at).toISOString() }
}

/** The paragraph a repeating time's prompt becomes in the task's text. */
export const everyParagraph = (cron: string, prompt: string): string => `Every ${cron.trim()}: ${prompt.trim()}`

/** The paragraph the prompt of a mail channel becomes in the text of a task that existed before. */
export const mailParagraph = (prompt: string): string => `On mail: ${prompt.trim()}`

/** The task's text with the paragraph added as its own; null when the text holds it already (nothing to write). */
export function withParagraph(content: string | null | undefined, paragraph: string): string | null {
  const text = (content ?? '').trimEnd()
  if (text.includes(paragraph)) return null
  return text ? `${text}\n\n${paragraph}` : paragraph
}

/**
 * Why one more task of the space cannot get a schedule, or null. `scheduled`: its open tasks that have one now. A
 * task that already has a schedule takes another time without counting again.
 */
export function limitRefusal(scheduled: number, limit: number): string | null {
  return scheduled >= limit ? `this space already has ${scheduled} tasks with a schedule; end one first (at most ${limit})` : null
}

/** How many of the tasks are open and have a schedule. */
export const scheduledCount = (tasks: readonly ToolTask[]): number => tasks.filter((task) => isOpenTask(task) && hasSchedule(task)).length

/**
 * The tools the task's sessions keep after a session set something on its record: never more than the record
 * allowed before, never more than that session has itself, and without what it denies on top. `before` undefined:
 * the task had no record.
 */
export function narrowedProfile(before: ToolProfile | null | undefined, caller: ToolProfile | null, deny: unknown): ToolProfile | null | 'invalid' {
  if (deny !== undefined && deny !== null && (!Array.isArray(deny) || !deny.every((name) => typeof name === 'string' && /^[\w.:*()-]+$/.test(name)))) return 'invalid'
  const more = (deny ?? []) as string[]
  if (!before && !caller && more.length === 0) return null
  const deniedTools = [...new Set([...(before?.deniedTools ?? []), ...(caller?.deniedTools ?? []), ...more])]
  const lists = [before?.mcpServers, caller?.mcpServers].filter((list): list is string[] => Array.isArray(list))
  const mcpServers = lists.length === 0 ? null : lists.reduce((kept, list) => kept.filter((name) => list.includes(name)))
  return { deniedTools, mcpServers }
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i
const MAX_MAIL_MATCHES = 50

/** The mail trigger from `mail: { addresses?, domains? }`; null when not given, or why it is wrong. */
export function mailTrigger(value: unknown): ChannelTrigger | null | string {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object' || Array.isArray(value)) return 'mail is { addresses?: [...], domains?: [...] }'
  const { addresses = [], domains = [] } = value as { addresses?: unknown; domains?: unknown }
  if (!Array.isArray(addresses) || !Array.isArray(domains)) return 'mail.addresses and mail.domains are lists'
  const bad = [...addresses.filter((a) => typeof a !== 'string' || !ADDRESS.test(a)), ...domains.filter((d) => typeof d !== 'string' || !DOMAIN.test(d))]
  if (bad.length) return `not a mail address or domain: ${bad.map(String).join(', ')} (a domain is written without @, e.g. example.com)`
  const match = [
    ...[...new Set((addresses as string[]).map((a) => a.toLowerCase()))].map((address) => ({ kind: 'address', address })),
    ...[...new Set((domains as string[]).map((d) => d.toLowerCase()))].map((domain) => ({ kind: 'domain', domain })),
  ]
  if (match.length === 0) return 'mail needs at least one address or domain'
  if (match.length > MAX_MAIL_MATCHES) return `at most ${MAX_MAIL_MATCHES} mail addresses and domains`
  return { type: 'mail', match }
}

/**
 * The schedule's next times from `now`, oldest first: at most `count`, and no more than `runsLeft` when the task
 * ends after so many runs. Empty for a schedule that is paused, ended or has nothing ahead.
 */
export function nextRuns(schedule: ScheduleFields | null | undefined, now: number, count: number, runsLeft: number | null = null): number[] {
  const out: number[] = []
  const most = runsLeft === null ? count : Math.min(count, Math.max(runsLeft, 0))
  let after = now
  while (out.length < most) {
    const next = nextRunOfSchedule(schedule, after)
    if (next === null) break
    after = Date.parse(next)
    out.push(after)
  }
  return out
}

/** "cron "0 8 * * 1-5" + once, Fri 13 Nov 10:00 (Asia/Makassar) + on mail from acme.example": what wakes the task. */
export function timesInWords(schedule: ScheduleFields | null, triggers: readonly ChannelTrigger[], zone: string): string {
  const times = [
    ...(schedule?.crons ?? []).map((cron) => `cron "${cron}"`),
    ...(schedule?.at ? [`once, ${formatInZone(Date.parse(schedule.at), zone)}`] : []),
  ]
  const channels = triggers.map((trigger) => {
    if (trigger.type !== 'mail') return `on ${trigger.type}`
    const from = (trigger.match as Array<Record<string, unknown>>).map((m) => String(m.address ?? m.domain ?? '')).filter(Boolean)
    return `on mail from ${from.join(', ')}`
  })
  return [...(times.length > 0 ? [`${times.join(' + ')} (${zone})`] : []), ...channels].join(' + ') || 'no schedule'
}

function describeRun(run: JobRun, zone: string): string {
  const when = formatInZone(Date.parse(run.startedAt ?? run.dueAt), zone)
  const how = run.status === 'finished' ? (run.outcome ?? 'ended without a status') : run.status
  return `${when}, ${how}${run.note ? ` (${run.note})` : ''}`
}

/** What the answer of create and update says while new mail addresses wait for the user. */
export const APPROVAL_NOTE = "It reacts to mail only after the user's OK on the task in the cockpit; until then mail for it waits. Replies are drafts the user approves."

/**
 * One task's schedule in a few lines, as the agent reads it: what wakes it, how it stands, its goal, its next runs
 * in words, when it ends and its last run. `zone`: where the user reads a time when the schedule names no zone.
 */
export function describeTask(task: ToolTask, record: Job | undefined, runs: readonly JobRun[], now: number, zone: string, project?: string | null): string {
  const schedule = scheduleOf(task)
  const tz = schedule?.time_zone ?? zone
  const lines = [`"${nameOfTask(task)}" (${task.id.slice(0, ID_PREFIX)}): ${timesInWords(schedule, record?.triggers ?? [], tz)}`]
  const ended = schedule?.ends_at && now > Date.parse(schedule.ends_at)
  const state = !isOpenTask(task) ? 'the task is closed: nothing fires'
    : record?.pendingApproval ? "waiting for the user's OK on the task"
      : schedule?.paused ? `paused${record?.pausedReason ? ` (${record.pausedReason})` : ''}`
        : record?.pausedReason ? `held (${record.pausedReason})`
          : ended ? 'past its end: nothing fires' : null
  if (state) lines.push(`  state: ${state}`)
  if (task.properties?.goal) lines.push(`  goal: ${task.properties.goal}`)
  if (record?.limited) {
    const lent = activeGrants(record, now).map((g) => g.tool)
    lines.push(`  limited: no shell, no messages to sessions, only the brain MCP; the schedule tool reaches only this task${lent.length ? `; lent for now: ${lent.join(', ')}` : ''}`)
  }
  const left = record?.end ? record.end.afterRuns - record.runCount : null
  const next = nextRuns(schedule, now, 3, left)
  if (next.length > 0) lines.push(`  next: ${next.map((at) => formatInZone(at, tz)).join(', ')}`)
  if (schedule?.at && schedule.by_session) lines.push('  the wake-up continues the session that set it')
  const ends = [...(left !== null ? [`after ${Math.max(left, 0)} more run${left === 1 ? '' : 's'}`] : []), ...(schedule?.ends_at ? [`at ${formatInZone(Date.parse(schedule.ends_at), tz)}`] : [])]
  if (ends.length > 0) lines.push(`  ends: ${ends.join(', ')}`)
  if (project) lines.push(`  new sessions start in: ${project}`)
  const last = [...runs].reverse().find((run) => run.number > 0 || !isOpenRun(run))
  if (last) lines.push(`  last run: ${describeRun(last, tz)}`)
  return lines.join('\n')
}
