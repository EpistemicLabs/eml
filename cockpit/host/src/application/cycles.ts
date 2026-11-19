import type { EmlApi } from '@engramprotocol/mcp-server'
import { taskSystemOn, type BrainSpace } from '../brain-space.js'

/**
 * Cycles (decision cockpit-task-views-follow-linear-model): one cycle per
 * calendar week (Monday to Sunday, the user's time zone) across all projects
 * of a space with the task system on. A cycle is a brain subject
 * (cycle-<year>-w<week>); a task is in the cycle when it carries the subject.
 * When a new week starts, the cockpit makes its subject, moves what was left
 * open in the last cycle into it (the task keeps the old subject too, so the
 * rollovers can be counted) and closes the last one.
 */

export interface Cycle {
  id: string
  /** ISO week number. */
  week: number
  /** Monday and Sunday, YYYY-MM-DD. */
  from: string
  to: string
}

const DAY = 24 * 60 * 60 * 1000

/** The calendar day in a time zone, as a UTC midnight date. */
function dayIn(now: Date, timeZone: string): Date {
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return new Date(`${ymd}T00:00:00Z`)
}

const iso = (d: Date) => d.toISOString().slice(0, 10)

/** The cycle (ISO week) a moment falls in, in the user's time zone; `offset` weeks later or earlier. */
export function cycleOf(now: Date, timeZone: string, offset = 0): Cycle {
  const day = new Date(dayIn(now, timeZone).getTime() + offset * 7 * DAY)
  const weekday = (day.getUTCDay() + 6) % 7 // Monday 0
  const monday = new Date(day.getTime() - weekday * DAY)
  // The ISO week belongs to the year of its Thursday.
  const thursday = new Date(monday.getTime() + 3 * DAY)
  const year = thursday.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(year, 0, 4))
  const firstMonday = new Date(firstThursday.getTime() - ((firstThursday.getUTCDay() + 6) % 7) * DAY)
  const week = Math.round((monday.getTime() - firstMonday.getTime()) / (7 * DAY)) + 1
  return { id: `cycle-${year}-w${String(week).padStart(2, '0')}`, week, from: iso(monday), to: iso(new Date(monday.getTime() + 6 * DAY)) }
}

/** How many cycles a task was carried through: its cycle subjects but one. */
export const rollovers = (subjects: string[] = []) => Math.max(0, subjects.filter((s) => s.startsWith('cycle-')).length - 1)

interface Task { id: string; subjects?: string[] }

export interface CyclesDeps {
  spaces: { list(): BrainSpace[] }
  brain(space: BrainSpace): Pick<EmlApi, 'get' | 'post' | 'put'> | null
  timeZone(): string
  log(line: string): void
  now?: () => Date
}

export function createCycles(deps: CyclesDeps) {
  const now = () => deps.now?.() ?? new Date()

  /** The space's current cycle exists; what the last one left open moved into it. */
  const ensureSpace = async (space: BrainSpace, brain: Pick<EmlApi, 'get' | 'post' | 'put'>) => {
    const current = cycleOf(now(), deps.timeZone())
    const exists = await brain.get(`/object/subject/${current.id}`).then(() => true, () => false)
    if (exists) return
    await brain.post('/object/subject', { name: current.id, description: `Cycle, week ${current.week}: ${current.from} to ${current.to}.` })
    const last = cycleOf(now(), deps.timeZone(), -1)
    let moved = 0
    for (const status of ['planned', 'active']) {
      const open = await brain.get('/list', { type: 'task', subject: last.id, status, limit: 500 }).catch(() => ({ engrams: [] })) as { engrams?: Task[] }
      for (const task of open.engrams ?? []) {
        await brain.post(`/task/${task.id}/track`, { subjects: [...new Set([...(task.subjects ?? []), current.id])] })
        moved += 1
      }
    }
    await brain.put(`/object/subject/${last.id}`, { status: 'closed' }).catch(() => { /* no last cycle */ })
    deps.log(`[cycles] ${space.name}: ${current.id} started, ${moved} task(s) carried over from ${last.id}`)
  }

  const ensure = async () => {
    for (const space of deps.spaces.list()) {
      if (!taskSystemOn(space)) continue
      const brain = deps.brain(space)
      if (!brain) continue
      await ensureSpace(space, brain).catch((err) => deps.log(`[cycles] ${space.name}: ${(err as Error).message}`))
    }
  }

  return {
    current: () => cycleOf(now(), deps.timeZone()),
    next: () => cycleOf(now(), deps.timeZone(), 1),
    ensure,
    /** Checks every `ms` (the week turns at midnight in the user's zone); returns the stop. */
    every(ms: number): () => void {
      void ensure()
      const timer = setInterval(() => { void ensure() }, ms)
      timer.unref?.()
      return () => clearInterval(timer)
    },
  }
}

export type Cycles = ReturnType<typeof createCycles>

/** The planner's first message (a session like the project lead, for the cycle). */
export function plannerPrompt(current: Cycle, next: Cycle, last: Cycle): string {
  return [
    `You are the cycle planner. This week is ${current.id} (${current.from} to ${current.to}); next week is ${next.id}.`,
    '',
    'A cycle is the user\'s commitment for one week across all projects: a task is in it when it carries the cycle\'s subject. Nothing outside it is promised.',
    '',
    'First read, without changing anything:',
    `- what ${last.id} left: eml_list type=task subject=${last.id} (resolved and still open).`,
    `- what is in ${current.id} already: eml_list type=task subject=${current.id}, status planned and active.`,
    '- what is due or urgent: eml_list type=task with status active and planned; look at priority and due_date.',
    '- project status of the busiest projects (eml_show project.<id>).',
    '',
    'Then propose the cycle: about as many tasks as the user finished last cycle, the carried ones first, then due and urgent, then what moves a project at risk. Name tasks carried twice or more and ask whether they stay. Ask before you change anything.',
    '',
    'When the user agrees, put each task in the cycle with eml_track_task: subjects = its current subjects plus the cycle id (eml_get shows them; the list replaces them). To take one out, pass its subjects without the cycle id.',
    'You work on no task of your own. When the plan is set, say so in one line.',
  ].join('\n')
}
