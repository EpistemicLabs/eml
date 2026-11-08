import { randomUUID } from 'node:crypto'
import {
  describeTrigger, isOpenRun, JOB_LIMITS, jobTimeZone, mailKeys, nextDue,
  activeGrants, type ChannelTrigger, type GrantTool, type Job, type JobEnd, type JobNotify, type JobRun, type JobTarget, type ReplyChannel, type ReplyMode, type ScheduleTrigger,
} from '../domain/job.js'
import { formatInZone, isTimeZone, parseAt, parseCron, shortestGap } from '../domain/schedule.js'
import type { ToolProfile } from '../domain/tool-profile.js'
import type { JobStore } from '../job-store.js'
import type { JobRunner } from './job-runner.js'

/**
 * What a session (the schedule tool, its CLI) or the user (the page) does with
 * jobs: create, list, update, pause, resume, delete, run now. A session reaches
 * only the jobs of its own space, and a job it makes runs in that space with at
 * most the tools the session has. Answers are text the agent reads.
 */

export const JOB_ACTIONS = ['create', 'list', 'update', 'pause', 'resume', 'delete', 'run_now'] as const
export type JobAction = typeof JOB_ACTIONS[number]

export interface JobCaller {
  /** Null: the user, from the page. */
  sessionId: string | null
  spaceId: string | null
  /** The caller's project: a worker job runs there unless it names another. */
  projectId: string | null
  toolProfile: ToolProfile | null
}

export interface JobsDeps {
  store: JobStore
  runner: Pick<JobRunner, 'runNow' | 'tick'>
  now?: () => number
  /** A project of the space as a session names it (registry id, brain project id or name, known folder). */
  resolveProject(spaceId: string | null, input: string): Promise<string | null>
  /** A session of the space by id or address; null when unknown or in another space. */
  findSession(spaceId: string | null, target: string): string | null
  addressOf(sessionId: string): string
  /** A project's name as the user sees it; the id when unknown. */
  projectName?(spaceId: string | null, projectId: string): string
  providerKnown(id: string): boolean
  /** The zone times read in when a job names none: the user's (from their browser), else the host's. */
  defaultTimeZone(): string
  /** A grant was stored: the job's session should pick the tool up (restart it and tell it). */
  onGrant?(job: Job, tool: GrantTool): void
}

export interface JobAnswer {
  status: number
  text: string
  job?: Job
}

const str = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined
const bad = (text: string): JobAnswer => ({ status: 400, text })

export class Jobs {
  private readonly now: () => number

  constructor(private deps: JobsDeps) {
    this.now = deps.now ?? Date.now
  }

  async handle(caller: JobCaller, input: Record<string, unknown>): Promise<JobAnswer> {
    const action = input.action
    switch (action) {
      case 'create': return this.create(caller, input)
      case 'list': return this.list(caller)
      case 'update': return this.withJob(caller, input, (job) => this.update(job, input))
      case 'pause': return this.withJob(caller, input, (job) => this.setPaused(job, true))
      case 'resume': return this.withJob(caller, input, (job) => this.setPaused(job, false))
      case 'delete': return this.withJob(caller, input, (job) => this.remove(job))
      case 'run_now': return this.withJob(caller, input, (job) => this.runNow(job))
      default: return bad(`action must be one of ${JOB_ACTIONS.join(', ')}`)
    }
  }

  /** The caller's space's jobs, newest first (all spaces for the page when spaceId is undefined). */
  jobsOf(spaceId: string | null | undefined): Job[] {
    return this.deps.store.list()
      .filter((job) => spaceId === undefined || (job.spaceId ?? null) === (spaceId ?? null))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  private async create(caller: JobCaller, input: Record<string, unknown>): Promise<JobAnswer> {
    const name = str(input.name)
    const prompt = str(input.prompt)
    if (!name || name.length > JOB_LIMITS.nameChars) return bad(`name is required (at most ${JOB_LIMITS.nameChars} characters)`)
    if (!prompt || prompt.length > JOB_LIMITS.promptChars) return bad(`prompt is required (at most ${JOB_LIMITS.promptChars} characters): what the woken session should do`)
    const active = this.jobsOf(caller.spaceId).filter((job) => !job.endedAt)
    if (active.length >= JOB_LIMITS.perSpace) return bad(`this space already has ${active.length} jobs; delete one first (at most ${JOB_LIMITS.perSpace})`)
    if (active.some((job) => job.name.toLowerCase() === name.toLowerCase())) return bad(`a job named "${name}" exists; pick another name or update it`)

    const mail = mailTrigger(input.mail)
    if (typeof mail === 'string') return bad(mail)
    // A mail job needs no schedule; with one it is woken by both.
    const scheduled = !mail || input.cron !== undefined || input.at !== undefined
    const trigger = scheduled ? this.trigger(input, undefined) : null
    if (typeof trigger === 'string') return bad(trigger)
    const end = this.end(input, trigger?.timeZone ?? this.deps.defaultTimeZone())
    if (typeof end === 'string') return bad(end)
    // One session that keeps the conversation fits a mail job; a fresh one per run a routine.
    const target = await this.target(caller, mail && input.target === undefined && input.session === undefined ? { ...input, target: 'job-session' } : input)
    if (typeof target === 'string') return bad(target)
    const notify = this.notify(input.notify)
    if (notify === null) return bad('notify must be needs-me, always or never')
    const toolProfile = narrowed(caller.toolProfile, input.deny_tools)
    if (toolProfile === 'invalid') return bad('deny_tools is a list of tool names')

    const at = new Date(this.now()).toISOString()
    const draft: Job = {
      id: randomUUID(), name, kind: mail && !trigger ? 'standing' : 'routine', spaceId: caller.spaceId, createdBy: caller.sessionId, createdAt: at, updatedAt: at,
      taskId: str(input.task_id) ?? null, prompt, target, triggers: [...(trigger ? [trigger] : []), ...(mail ? [mail] : [])], toolProfile,
      // Drafts until the user switches a channel to send in the Jobs view; a session never can.
      reply: mail ? { mail: 'draft' } : {}, end, notify,
      paused: false, pausedReason: null, ...(mail ? { pendingApproval: true, limited: true } : {}), endedAt: null, nextRunAt: null, runCount: 0, failures: 0,
    }
    const next = nextDue(draft, this.now())
    if (next === null && trigger) return bad('that schedule has no run before its end')
    const job = { ...draft, nextRunAt: next === null ? null : new Date(next).toISOString() }
    this.deps.store.put(job)
    const waits = mail ? `\n${APPROVAL_NOTE}` : ''
    return { status: 201, job, text: `Created job "${job.name}" (${job.id.slice(0, 8)}).\n${this.describe(job)}${waits}` }
  }

  private list(caller: JobCaller): JobAnswer {
    const jobs = this.jobsOf(caller.spaceId)
    if (jobs.length === 0) return { status: 200, text: 'No jobs in this space.' }
    return { status: 200, text: jobs.map((job) => `- ${this.describe(job)}`).join('\n') }
  }

  private async update(job: Job, input: Record<string, unknown>): Promise<JobAnswer> {
    let next: Job = { ...job }
    const name = str(input.name)
    if (name !== undefined) {
      if (name.length > JOB_LIMITS.nameChars) return bad(`name: at most ${JOB_LIMITS.nameChars} characters`)
      next.name = name
    }
    const prompt = str(input.prompt)
    if (prompt !== undefined) {
      if (prompt.length > JOB_LIMITS.promptChars) return bad(`prompt: at most ${JOB_LIMITS.promptChars} characters`)
      next.prompt = prompt
    }
    const current = job.triggers.find((t): t is ScheduleTrigger => t.type === 'schedule')
    const scheduleChanged = input.cron !== undefined || input.at !== undefined || input.timezone !== undefined
    if (scheduleChanged) {
      const trigger = this.trigger(input, current)
      if (typeof trigger === 'string') return bad(trigger)
      next.triggers = [...job.triggers.filter((t) => t.type !== 'schedule'), trigger]
    }
    if (input.max_runs !== undefined || input.ends_at !== undefined) {
      const end = this.end(input, jobTimeZone(next, this.deps.defaultTimeZone()))
      if (typeof end === 'string') return bad(end)
      next.end = end
    }
    if (input.notify !== undefined) {
      const notify = this.notify(input.notify)
      if (notify === null) return bad('notify must be needs-me, always or never')
      next.notify = notify
    }
    if (input.task_id !== undefined) next.taskId = str(input.task_id) ?? null
    let waits = ''
    if (input.mail !== undefined) {
      const mail = mailTrigger(input.mail)
      if (typeof mail === 'string') return bad(mail)
      next.triggers = [...next.triggers.filter((t) => t.type !== 'mail'), ...(mail ? [mail] : [])]
      if (mail) next.reply = { ...next.reply, mail: next.reply.mail ?? 'draft' }
      // Fewer addresses need nobody's OK; a new one does.
      const before = mailKeys(job)
      if ([...mailKeys(next)].some((key) => !before.has(key))) {
        next.pendingApproval = true
        waits = `\n${APPROVAL_NOTE}`
      }
    }
    const due = nextDue(next, this.now())
    next = { ...next, nextRunAt: due === null ? null : new Date(due).toISOString(), updatedAt: new Date(this.now()).toISOString() }
    // A new time can bring an ended job back.
    if (due !== null) next.endedAt = null
    this.deps.store.put(next)
    return { status: 200, job: next, text: `Updated job "${next.name}".\n${this.describe(next)}${waits}` }
  }

  private setPaused(job: Job, paused: boolean): JobAnswer {
    if (job.endedAt && !paused) return bad(`job "${job.name}" has ended; give it a new time with update`)
    const at = this.now()
    // Resumed, it goes on from now: what fell due during the pause is not made up.
    const due = paused ? null : nextDue(job, at)
    const next: Job = {
      ...job, paused, pausedReason: null, failures: paused ? job.failures : 0, updatedAt: new Date(at).toISOString(),
      ...(paused ? {} : { nextRunAt: due === null ? null : new Date(due).toISOString() }),
    }
    this.deps.store.put(next)
    return { status: 200, job: next, text: `${paused ? 'Paused' : 'Resumed'} job "${job.name}".\n${this.describe(next)}` }
  }

  private remove(job: Job): JobAnswer {
    this.deps.store.remove(job.id)
    return { status: 200, text: `Deleted job "${job.name}" and its history.` }
  }

  private runNow(job: Job): JobAnswer {
    if (job.endedAt) return bad(`job "${job.name}" has ended`)
    if (job.pendingApproval) return bad(`job "${job.name}" waits for the user's OK in the Jobs view`)
    const run = this.deps.runner.runNow(job)
    if (!run) return { status: 409, text: `Job "${job.name}" has a run still going; wait for it to finish.` }
    return { status: 202, job, text: `Run ${run.number} of "${job.name}" starts as soon as there is room.` }
  }

  private async withJob(caller: JobCaller, input: Record<string, unknown>, act: (job: Job) => JobAnswer | Promise<JobAnswer>): Promise<JobAnswer> {
    const key = str(input.job)
    if (!key) return bad('job is required: its id (or the first 8 characters) or its exact name')
    const jobs = this.jobsOf(caller.spaceId)
    const byId = jobs.filter((job) => job.id === key || (key.length >= 6 && job.id.startsWith(key)))
    const matches = byId.length ? byId : jobs.filter((job) => job.name.toLowerCase() === key.toLowerCase())
    if (matches.length === 0) return { status: 404, text: `No job "${key}" in this space. The list action shows them.` }
    if (matches.length > 1) return bad(`"${key}" fits ${matches.length} jobs; use the id`)
    return act(matches[0])
  }

  /** The schedule trigger from the input; `current` fills in what an update leaves out. */
  private trigger(input: Record<string, unknown>, current: ScheduleTrigger | undefined): ScheduleTrigger | string {
    const timeZone = str(input.timezone) ?? current?.timeZone ?? this.deps.defaultTimeZone()
    if (!isTimeZone(timeZone)) return `unknown time zone "${timeZone}"; use an IANA name such as Europe/Berlin`
    const cron = str(input.cron) ?? (input.at === undefined && current?.cron !== undefined ? current.cron : undefined)
    const atText = str(input.at) ?? (input.cron === undefined && current?.at !== undefined ? current.at : undefined)
    if ((cron === undefined) === (atText === undefined)) return 'give exactly one of cron (repeating) or at (one time)'
    if (cron !== undefined) {
      let spec
      try { spec = parseCron(cron) } catch (err) { return `cron: ${(err as Error).message}` }
      const gap = shortestGap(spec, timeZone, this.now())
      if (gap === null && nextDue({ triggers: [{ type: 'schedule', cron, timeZone }], end: null, runCount: 0 }, this.now()) === null) return 'that cron never fires'
      if (gap !== null && gap < JOB_LIMITS.minGapMs) return `that cron fires every ${Math.round(gap / 60_000)} min; at most every ${JOB_LIMITS.minGapMs / 60_000} min`
      return { type: 'schedule', cron, timeZone }
    }
    const at = parseAt(atText!, timeZone)
    if (at === null) return `at: "${atText}" is not a date and time; write it like 2026-11-13T10:00 (read in ${timeZone})`
    if (at <= this.now()) return `at: ${formatInZone(at, timeZone)} (${timeZone}) has passed`
    if (at - this.now() > JOB_LIMITS.maxAheadMs) return 'at: at most a year ahead'
    return { type: 'schedule', at: new Date(at).toISOString(), timeZone }
  }

  private end(input: Record<string, unknown>, timeZone: string): JobEnd | null | string {
    const end: JobEnd = {}
    if (input.max_runs !== undefined && input.max_runs !== null) {
      if (!Number.isInteger(input.max_runs) || (input.max_runs as number) < 1) return 'max_runs is a whole number from 1'
      end.afterRuns = input.max_runs as number
    }
    const endsAt = str(input.ends_at)
    if (endsAt) {
      const at = parseAt(endsAt, timeZone)
      if (at === null) return `ends_at: "${endsAt}" is not a date and time`
      end.at = new Date(at).toISOString()
    }
    return Object.keys(end).length ? end : null
  }

  private notify(value: unknown): JobNotify | null {
    if (value === undefined || value === null) return 'needs-me'
    return value === 'needs-me' || value === 'always' || value === 'never' ? value : null
  }

  private async target(caller: JobCaller, input: Record<string, unknown>): Promise<JobTarget | string> {
    const kind = str(input.target) ?? (input.session !== undefined ? 'session' : 'worker')
    if (kind === 'self') {
      if (!caller.sessionId) return 'target self needs a session'
      return { type: 'session', sessionId: caller.sessionId }
    }
    if (kind === 'session') {
      const name = str(input.session)
      if (!name) return 'target session needs session: its address'
      const sessionId = this.deps.findSession(caller.spaceId, name)
      return sessionId ? { type: 'session', sessionId } : `no session "${name}" in this space`
    }
    if (kind !== 'worker' && kind !== 'job-session') return 'target must be worker, job-session, self or session'
    const projectInput = str(input.project)
    const projectId = projectInput ? await this.deps.resolveProject(caller.spaceId, projectInput) : caller.projectId
    if (!projectId) return projectInput ? `unknown project "${projectInput}"` : 'project is required for a worker'
    const provider = str(input.provider)
    if (provider && !this.deps.providerKnown(provider)) return `unknown provider "${provider}"`
    return kind === 'worker'
      ? { type: 'worker', projectId, ...(provider ? { provider: provider as never } : {}) }
      : { type: 'job-session', projectId, ...(provider ? { provider: provider as never } : {}), sessionId: null }
  }

  /** The user's OK in the Jobs view: the job's channel addresses may wake it. Only the page calls this. */
  approve(job: Job): JobAnswer {
    if (!job.pendingApproval) return { status: 200, job, text: `Job "${job.name}" needs no OK.` }
    const next: Job = { ...job, pendingApproval: false, updatedAt: new Date(this.now()).toISOString() }
    const due = nextDue(next, this.now())
    next.nextRunAt = due === null ? null : new Date(due).toISOString()
    this.deps.store.put(next)
    return { status: 200, job: next, text: `Approved job "${job.name}".` }
  }

  /** Send freely or draft for review, per channel. Only the page calls this: a session never widens it. */
  setReply(job: Job, channel: ReplyChannel, mode: ReplyMode): JobAnswer {
    if (!job.triggers.some((t) => t.type === channel)) return bad(`job "${job.name}" does not listen on ${channel}`)
    const next: Job = { ...job, reply: { ...job.reply, [channel]: mode }, updatedAt: new Date(this.now()).toISOString() }
    this.deps.store.put(next)
    return { status: 200, job: next, text: `Job "${job.name}" ${mode === 'send' ? 'sends' : 'drafts'} ${channel} replies.` }
  }

  /** Limited or free (the user's switch in the Jobs view). Only the page calls this. */
  setLimited(job: Job, limited: boolean): JobAnswer {
    const next: Job = { ...job, limited, updatedAt: new Date(this.now()).toISOString() }
    this.deps.store.put(next)
    return { status: 200, job: next, text: `Job "${job.name}" is ${limited ? 'limited' : 'no longer limited'}.` }
  }

  /** Lend a limited job a tool for `minutes` (the user's click). Only the page calls this. */
  grant(job: Job, tool: GrantTool, minutes: number, reason: string | null): JobAnswer {
    if (!Number.isFinite(minutes) || minutes < GRANT_MINUTES.min || minutes > GRANT_MINUTES.max) {
      return bad(`minutes is from ${GRANT_MINUTES.min} to ${GRANT_MINUTES.max}`)
    }
    const now = this.now()
    const until = new Date(now + minutes * 60_000).toISOString()
    const grants = [...activeGrants(job, now).filter((g) => g.tool !== tool), { tool, until, reason }]
    const next: Job = { ...job, grants, updatedAt: new Date(now).toISOString() }
    this.deps.store.put(next)
    this.deps.onGrant?.(next, tool)
    return { status: 200, job: next, text: `Job "${job.name}" may use ${tool} until ${until}.` }
  }

  /** Take a lent tool back (the user's click). Only the page calls this. */
  revoke(job: Job, tool: GrantTool): JobAnswer {
    const next: Job = { ...job, grants: (job.grants ?? []).filter((g) => g.tool !== tool), updatedAt: new Date(this.now()).toISOString() }
    this.deps.store.put(next)
    return { status: 200, job: next, text: `Job "${job.name}" no longer has ${tool}.` }
  }

  /** What the page shows of a job: its schedule and target in words, its next run times. */
  summary(job: Job): { schedule: string; wakes: string; nextRuns: string[] } {
    return {
      schedule: job.triggers.map(describeTrigger).join(' + '),
      wakes: this.describeTarget(job),
      nextRuns: job.paused || job.endedAt ? [] : this.nextRuns(job, 3).map((at) => new Date(at).toISOString()),
    }
  }

  /** One job in a few lines: schedule, next runs, target, last run. */
  describe(job: Job): string {
    const zone = jobTimeZone(job, this.deps.defaultTimeZone())
    const schedule = job.triggers.map(describeTrigger).join(' + ')
    const lines = [`"${job.name}" (${job.id.slice(0, 8)}): ${schedule}`]
    const state = job.endedAt ? 'ended'
      : job.pendingApproval ? "waiting for the user's OK in the Jobs view"
        : job.paused ? `paused${job.pausedReason ? ` (${job.pausedReason})` : ''}` : null
    if (state) lines.push(`  state: ${state}`)
    if (job.limited) {
      const lent = activeGrants(job, this.now()).map((g) => g.tool)
      lines.push(`  limited: no shell, no messages to sessions, no schedule tool, only the brain MCP${lent.length ? `; lent for now: ${lent.join(', ')}` : ''}`)
    }
    else if (job.nextRunAt) lines.push(`  next: ${this.nextRuns(job, 3).map((at) => formatInZone(at, zone)).join(', ')}`)
    lines.push(`  wakes: ${this.describeTarget(job)}`)
    const last = [...this.deps.store.runs(job.id)].reverse().find((run) => run.number > 0 || !isOpenRun(run))
    if (last) lines.push(`  last run: ${describeRun(last, zone)}`)
    return lines.join('\n')
  }

  private nextRuns(job: Job, count: number): number[] {
    const out: number[] = []
    let at = job.nextRunAt ? Date.parse(job.nextRunAt) : null
    let runCount = job.runCount
    while (at !== null && out.length < count) {
      out.push(at)
      runCount += 1
      at = nextDue({ ...job, runCount }, at)
    }
    return out
  }

  private describeTarget({ target, spaceId }: Job): string {
    if (target.type === 'session') return `session ${this.deps.addressOf(target.sessionId)}`
    const project = this.deps.projectName?.(spaceId, target.projectId) ?? target.projectId
    if (target.type === 'job-session') return target.sessionId ? `its own session ${this.deps.addressOf(target.sessionId)}` : `its own session (started on the first run) in ${project}`
    return `a new worker per run in ${project}`
  }
}

function describeRun(run: JobRun, zone: string): string {
  const when = formatInZone(Date.parse(run.startedAt ?? run.dueAt), zone)
  const how = run.status === 'finished' ? (run.outcome ?? 'ended without a status') : run.status
  return `${when}, ${how}${run.note ? ` (${run.note})` : ''}`
}

const GRANT_MINUTES = { min: 5, max: 24 * 60 }

const APPROVAL_NOTE = "It reacts to mail only after the user's OK in the Jobs view; until then mail for it waits. Replies are drafts the user approves."
const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i
const MAX_MAIL_MATCHES = 50

/** The mail trigger from `mail: { addresses?, domains? }`; null when not given, or why it is wrong. */
function mailTrigger(value: unknown): ChannelTrigger | null | string {
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

/** The caller's profile with more tools denied; never fewer. */
function narrowed(profile: ToolProfile | null, deny: unknown): ToolProfile | null | 'invalid' {
  if (deny === undefined || deny === null) return profile ? { ...profile, deniedTools: [...profile.deniedTools] } : null
  if (!Array.isArray(deny) || !deny.every((name) => typeof name === 'string' && /^[\w.:*()-]+$/.test(name))) return 'invalid'
  const deniedTools = [...new Set([...(profile?.deniedTools ?? []), ...deny as string[]])]
  return { deniedTools, mcpServers: profile?.mcpServers ?? null }
}
