import { describe, expect, it } from 'vitest'
import { lendJobTool } from '../src/application/lend-job-tool.js'
import { takeBackJobTools } from '../src/application/take-back-job-tools.js'
import type { JobSessions } from '../src/application/lend-job-tool.js'
import type { Job } from '../src/domain/job.js'
import { formatInZone } from '../src/domain/schedule.js'

const job = (grants: Job['grants'] = []): Job => ({
  id: 'job-1', name: 'Mail', grants, triggers: [{ type: 'schedule', cron: '0 8 * * *', timeZone: 'Europe/Berlin' }],
} as unknown as Job)

/** Sessions of a job as the host sees them; `working` ones end their turn when `finishTurn` is called. */
function fakeSessions(sessions: Array<{ id: string; runs: boolean; working?: boolean }>) {
  const events: string[] = []
  const waiting = new Map<string, () => void>()
  const state = new Map(sessions.map((s) => [s.id, { ...s }]))
  const deps: JobSessions = {
    sessionsOf: (jobId) => (jobId === 'job-1' ? sessions.map((s) => s.id) : []),
    runs: (id) => state.get(id)?.runs ?? false,
    turnOver: (id) => {
      if (!state.get(id)?.working) return Promise.resolve()
      events.push(`wait ${id}`)
      return new Promise((resolve) => waiting.set(id, resolve))
    },
    stop: async (id) => {
      events.push(`stop ${id}`)
      state.get(id)!.runs = false
    },
    deliver: async (id, text) => {
      events.push(`deliver ${id}: ${text}`)
      return 'resumed'
    },
    timeZone: () => 'Europe/Berlin',
    log: () => {},
  }
  const finishTurn = (id: string) => {
    state.get(id)!.working = false
    waiting.get(id)?.()
  }
  return { deps, events, finishTurn }
}

const until = '2026-11-08T13:30:00.000Z'
const at = `${formatInZone(Date.parse(until), 'Europe/Berlin')} (Europe/Berlin)`

describe('lendJobTool', () => {
  it('stops the job\'s idle session and tells it what it was lent, so it resumes with the tool', async () => {
    const { deps, events } = fakeSessions([{ id: 's-new', runs: true }, { id: 's-old', runs: false }])
    await lendJobTool(deps, job([{ tool: 'chrome', until, reason: 'submit the return' }]), 'chrome')
    expect(events).toEqual([
      'stop s-new',
      `deliver s-new: The user lent you Chrome until ${at}: submit the return`,
    ])
  })

  it('lets a session mid-turn finish its turn before it stops', async () => {
    const { deps, events, finishTurn } = fakeSessions([{ id: 's-1', runs: true, working: true }])
    const done = lendJobTool(deps, job([{ tool: 'SendMessage', until, reason: null }]), 'SendMessage')
    await Promise.resolve()
    expect(events).toEqual(['wait s-1'])
    finishTurn('s-1')
    await done
    expect(events).toEqual(['wait s-1', 'stop s-1', `deliver s-1: The user lent you SendMessage until ${at}.`])
  })

  it('resumes a stopped session with the note alone', async () => {
    const { deps, events } = fakeSessions([{ id: 's-1', runs: false }])
    await lendJobTool(deps, job([{ tool: 'chrome', until, reason: null }]), 'chrome')
    expect(events).toEqual([`deliver s-1: The user lent you Chrome until ${at}.`])
  })

  it('does nothing for a job without a session of its own yet: its first start gets the tool', async () => {
    const { deps, events } = fakeSessions([])
    await lendJobTool(deps, { ...job([{ tool: 'chrome', until, reason: null }]), id: 'job-2' }, 'chrome')
    expect(events).toEqual([])
  })
})

describe('takeBackJobTools', () => {
  it('stops every running session of the job after its turn, so the next start comes without the tool', async () => {
    const { deps, events, finishTurn } = fakeSessions([
      { id: 's-busy', runs: true, working: true }, { id: 's-idle', runs: true }, { id: 's-gone', runs: false },
    ])
    const done = takeBackJobTools(deps, job(), ['chrome'])
    await Promise.resolve()
    expect(events).toEqual(['wait s-busy', 'stop s-idle'])
    finishTurn('s-busy')
    await done
    expect(events).toEqual(['wait s-busy', 'stop s-idle', 'stop s-busy'])
  })

  it('leaves a session that stopped on its own while its turn ran', async () => {
    const { deps, events } = fakeSessions([{ id: 's-1', runs: false }])
    await takeBackJobTools(deps, job(), ['SendMessage'])
    expect(events).toEqual([])
  })
})
