import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { DeliveryOutcome } from '../src/domain/session-delivery.js'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-continue-session-'))
process.env.EML_COCKPIT_HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))

const { createContinueSession } = await import('../src/application/continue-session.js')
const { LONG_CONTEXT_TOKENS } = await import('../src/domain/own-session.js')

type Entry = { sessionId: string; taskId: string | null; createdAt: string; archivedAt: string | null; parentSessionId: string | null; jobId: string | null; runtime: 'terminal' | 'sdk'; runStartedAt: string | null }
const entry = (sessionId: string, more: Partial<Entry> = {}): Entry => ({
  sessionId, taskId: 't1', createdAt: '2026-11-25T09:00:00.000Z', archivedAt: null, parentSessionId: null, jobId: null, runtime: 'sdk', runStartedAt: null, ...more,
})

function setup(entries: Entry[], opts: { tokens?: number | null; fresh?: boolean; outcome?: DeliveryOutcome } = {}) {
  const delivered: Array<{ sessionId: string; text: string }> = []
  let runs = 0
  const clock = { now: Date.parse('2026-11-25T10:00:00.000Z') }
  const ledger = {
    list: () => entries as never,
    get: (id: string) => entries.find((e) => e.sessionId === id) as never,
    startRun: (id: string, at: string) => { entries.find((e) => e.sessionId === id)!.runStartedAt = at },
  }
  const continueSession = createContinueSession({
    ledger,
    contextTokensOf: () => opts.tokens ?? 20_000,
    startFresh: () => opts.fresh ?? false,
    deliver: async (sessionId, text) => {
      delivered.push({ sessionId, text })
      clock.now += 5000
      return opts.outcome ?? 'delivered'
    },
    runStarted: () => { runs++ },
    now: () => clock.now,
  })
  return { continueSession, delivered, runs: () => runs, entries }
}

const step = { id: 't1', title: 'Fix it', content: 'do it', projectId: 'bp-eml', checkpoint: 'after' }

describe('continuing the task\'s own session', () => {
  it('continues the newest own open session, and not a helper\'s, a job\'s or a put-away one', () => {
    const { continueSession } = setup([
      entry('own'), entry('newer', { createdAt: '2026-11-25T09:30:00.000Z' }),
      entry('helper', { createdAt: '2026-11-25T09:40:00.000Z', parentSessionId: 'own' }),
      entry('job', { createdAt: '2026-11-25T09:40:00.000Z', jobId: 'j1' }),
      entry('gone', { createdAt: '2026-11-25T09:50:00.000Z', archivedAt: '2026-11-25T09:55:00.000Z' }),
    ])
    expect(continueSession.toContinue('t1')).toBe('newer')
    expect(continueSession.boardView('t1')).toEqual({ sessionId: 'newer', continues: true })
    expect(continueSession.toContinue('t2')).toBeNull()
  })

  it('starts a new session instead when the context is very long, the session is a terminal, or the owner chose Start fresh', () => {
    expect(setup([entry('own')], { tokens: LONG_CONTEXT_TOKENS }).continueSession.toContinue('t1')).toBeNull()
    expect(setup([entry('own')], { tokens: LONG_CONTEXT_TOKENS }).continueSession.boardView('t1')).toEqual({ sessionId: 'own', continues: false })
    expect(setup([entry('own', { runtime: 'terminal' })]).continueSession.toContinue('t1')).toBeNull()
    expect(setup([entry('own')], { fresh: true }).continueSession.toContinue('t1')).toBeNull()
    // Start fresh is the delegation's choice: the board still names the session Take over opens
    expect(setup([entry('own')], { fresh: true }).continueSession.boardView('t1')).toEqual({ sessionId: 'own', continues: true })
  })

  it('gives the session the continued start prompt and starts its new run from just before the prompt went out', async () => {
    const { continueSession, delivered, runs, entries } = setup([entry('own')])
    expect(await continueSession.resume('own', step)).toEqual({ kind: 'continued' })
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text.split('\n')[0]).toBe('The owner delegated "Fix it" (task t1) to you: carry on with it on your own from where this conversation stands.')
    expect(entries[0].runStartedAt).toBe('2026-11-25T10:00:00.000Z')
    expect(runs()).toBe(1)
  })

  it('tells a continued session that a carried question was its own, not that the owner had asked it', async () => {
    const { continueSession, delivered } = setup([entry('own')])
    await continueSession.resume('own', { ...step, brief: 'The owner had an open question when this task was handed to you. Answer or settle it first: "Count it?"', question: 'Count it?' })
    expect(delivered[0].text).toContain('Your question was still open when the owner delegated this task: "Count it?".')
    expect(delivered[0].text).not.toContain('The owner had an open question')
  })

  it('knows from the ledger that a session was continued for a request, which outlives a restart', async () => {
    const { continueSession } = setup([entry('own', { runStartedAt: '2026-11-25T10:00:05.000Z' }), entry('other', { taskId: 't2' })])
    expect(continueSession.continuedFor('t1', '2026-11-25T10:00:00.000Z')).toBe(true)
    expect(continueSession.continuedFor('t1', '2026-11-25T10:00:05.000Z')).toBe(true)
    // a later delegation is a new request
    expect(continueSession.continuedFor('t1', '2026-11-25T11:00:00.000Z')).toBe(false)
    expect(continueSession.continuedFor('t2', '2026-11-25T10:00:00.000Z')).toBe(false)
  })

  it('starts no run when the session does not take the prompt: busy is tried again, one that cannot be reached falls back to a new session', async () => {
    for (const [outcome, kind] of [['busy', 'retry'], ['running', 'retry'], ['refused', 'fallback'], ['unknown', 'fallback']] as const) {
      const { continueSession, entries, runs } = setup([entry('own')], { outcome })
      expect(await continueSession.resume('own', step)).toMatchObject({ kind })
      expect(entries[0].runStartedAt).toBeNull()
      expect(runs()).toBe(0)
    }
    expect(await setup([entry('own')], { outcome: 'resumed' }).continueSession.resume('own', step)).toEqual({ kind: 'continued' })
  })
})
