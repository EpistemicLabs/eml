import fs from 'node:fs'
import path from 'node:path'
import { COCKPIT_HOME } from './paths.js'
import type { TurnEvent } from './turn-state.js'

/**
 * The Time plugin (task cockpit-plugin-time-tracking): work time, counted on
 * its own. Two clocks:
 *
 *   user    the time someone is at the cockpit. The open browser sends a beat
 *           every half minute while its tab is visible and had input in the
 *           last minutes (TimeBeat.tsx); the time between two beats goes to
 *           what was active at the first: its project, its session, the
 *           session's task. A gap longer than BEAT_GAP_MS counts nothing, and
 *           every browser feeds the same clock, so two tabs don't count twice.
 *   agent   the time a session's turn runs (TurnTracker), to its project,
 *           session and task. Agents run side by side, so it is no part of
 *           the user's total.
 *
 * One clock per cockpit, across its spaces: every figure carries its space,
 * whose names the route looks up (http.ts timeNames).
 *
 * Kept per local day as COCKPIT_HOME/time/<YYYY-MM-DD>.json: ids and seconds,
 * no content. Not in the brain: it is measurement, not knowledge. While the
 * plugin is off nothing is written.
 */

export const TIME_DIR = path.join(COCKPIT_HOME, 'time')

/** A beat later than this after the one before starts the clock anew. */
export const BEAT_GAP_MS = 90_000

export interface TimeSplit {
  user: number
  agent: number
}

/** Where a figure belongs: its space (null: the main space) and project (null: none, as the shell). */
export interface Place {
  spaceId: string | null
  projectId: string | null
}

export interface DayTime {
  date: string
  /** Seconds at the cockpit, all spaces and projects together. */
  user: number
  /** By projectKey. */
  projects: Record<string, TimeSplit & Place>
  tasks: Record<string, TimeSplit & Place>
  sessions: Record<string, TimeSplit & Place & { taskId: string | null }>
}

/** What a beat says is in front of the user: the open space, the active pane's session or project. */
export interface Focus extends Place {
  sessionId: string | null
}

export interface SessionInfo extends Place {
  taskId: string | null
}

/** A project's key in DayTime.projects: the same project id may be in two spaces. */
export const projectKey = (place: Place): string => `${place.spaceId ?? ''}/${place.projectId ?? ''}`

const emptyDay = (date: string): DayTime => ({ date, user: 0, projects: {}, tasks: {}, sessions: {} })

/** The local calendar day of a moment, as the user reads it. */
export function localDate(at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

export class TimeTracker {
  private lastBeat: { at: number; focus: Focus } | null = null
  private running = new Map<string, number>()

  constructor(
    /** The session's project and task, from the session ledger. */
    private readonly session: (sessionId: string) => SessionInfo | null,
    /** The plugin is on (Settings › EML Plugins). */
    private readonly isOn: () => Promise<boolean>,
    private readonly dir = TIME_DIR,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * A browser's beat: credits the time since the last one to what was in front
   * then. `fresh`: the user is back after a pause the browser saw (useTimeBeat's
   * AWAY_MS), so the time since the last beat does not count.
   */
  beat(focus: Focus, fresh = false): Promise<void> {
    const at = this.now()
    const last = this.lastBeat
    this.lastBeat = { at, focus }
    if (fresh || !last || at - last.at > BEAT_GAP_MS || at <= last.at) return Promise.resolve()
    return this.credit('user', (at - last.at) / 1000, this.resolve(last.focus), at)
  }

  /** A turn changed state: a running one starts the agent clock, any other stops it. */
  turn(event: TurnEvent): Promise<void> {
    const at = this.now()
    const started = this.running.get(event.sessionId)
    if (event.state === 'working') {
      if (started === undefined) this.running.set(event.sessionId, at)
      return Promise.resolve()
    }
    if (started === undefined) return Promise.resolve()
    this.running.delete(event.sessionId)
    return this.credit('agent', (at - started) / 1000, this.resolve({ spaceId: null, projectId: null, sessionId: event.sessionId }), at)
  }

  /** The recorded days, oldest first, today with the turns still running. */
  days(count: number): DayTime[] {
    const today = new Date(this.now())
    const days: DayTime[] = []
    for (let back = count - 1; back >= 0; back--) {
      const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back)
      days.push(this.read(localDate(day)))
    }
    const live = days[days.length - 1]
    for (const [sessionId, started] of this.running) {
      add(live, 'agent', (this.now() - started) / 1000, this.resolve({ spaceId: null, projectId: null, sessionId }))
    }
    return days
  }

  private resolve(focus: Focus): Focus & { taskId: string | null } {
    const info = focus.sessionId ? this.session(focus.sessionId) : null
    // A session's own space and project win: the ledger knows where it runs.
    return {
      spaceId: info ? info.spaceId : focus.spaceId,
      projectId: info?.projectId ?? focus.projectId,
      sessionId: focus.sessionId,
      taskId: info?.taskId ?? null,
    }
  }

  // Read, add and write run in one go after the check, so two credits never interleave.
  private async credit(clock: keyof TimeSplit, seconds: number, to: Focus & { taskId: string | null }, at: number): Promise<void> {
    if (!(await this.isOn())) return
    const day = this.read(localDate(new Date(at)))
    add(day, clock, seconds, to)
    this.write(day)
  }

  private file(date: string): string {
    return path.join(this.dir, `${date}.json`)
  }

  private read(date: string): DayTime {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(date), 'utf8')) as Partial<DayTime>
      return { ...emptyDay(date), ...raw, date }
    } catch {
      return emptyDay(date)
    }
  }

  private write(day: DayTime): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
      const file = this.file(day.date)
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(day), { mode: 0o600 })
      fs.renameSync(`${file}.tmp`, file)
    } catch (err) {
      process.stderr.write(`[time] write failed: ${(err as Error).message}\n`)
    }
  }
}

function add(day: DayTime, clock: keyof TimeSplit, seconds: number, to: Focus & { taskId: string | null }): void {
  if (!(seconds > 0)) return
  if (clock === 'user') day.user += seconds
  const place = { spaceId: to.spaceId, projectId: to.projectId }
  const project = (day.projects[projectKey(place)] ??= { user: 0, agent: 0, ...place })
  project[clock] += seconds
  if (to.taskId) {
    const task = (day.tasks[to.taskId] ??= { user: 0, agent: 0, ...place })
    task[clock] += seconds
  }
  if (to.sessionId) {
    const session = (day.sessions[to.sessionId] ??= { user: 0, agent: 0, ...place, taskId: to.taskId })
    session[clock] += seconds
  }
}
