import { describe, expect, it } from 'vitest'
import { interruptedWorkers, recoverWorkers, RECOVERY_MESSAGE, type RecoverWorkersDeps } from '../src/application/recover-workers.js'

function setup(workers: Array<{ sessionId: string; retried: boolean }>, outcome: 'resumed' | 'refused' | 'busy' = 'resumed') {
  const sent: string[] = []
  const retried: string[] = []
  const gaveUp: string[] = []
  const deps: RecoverWorkersDeps = {
    interrupted: () => workers,
    markRetried: (id) => { retried.push(id) },
    giveUp: (id) => { gaveUp.push(id) },
    deliver: async (_id, text) => { sent.push(text); return outcome },
    log: () => {},
  }
  return { deps, sent, retried, gaveUp }
}

describe('recoverWorkers', () => {
  it('a worker cut off once gets one message to carry on', async () => {
    const { deps, sent, retried, gaveUp } = setup([{ sessionId: 'w', retried: false }])
    expect(await recoverWorkers(deps)).toBe(1)
    expect(sent).toEqual([RECOVERY_MESSAGE])
    expect(retried).toEqual(['w'])
    expect(gaveUp).toEqual([])
  })

  it('cut off again, it waits for someone instead of looping', async () => {
    const { deps, sent, gaveUp } = setup([{ sessionId: 'w', retried: true }])
    expect(await recoverWorkers(deps)).toBe(0)
    expect(sent).toEqual([])
    expect(gaveUp).toEqual(['w'])
  })

  it.each(['refused', 'busy'] as const)('one that answers %s waits for someone', async (outcome) => {
    const { deps, gaveUp } = setup([{ sessionId: 'w', retried: false }], outcome)
    expect(await recoverWorkers(deps)).toBe(0)
    expect(gaveUp).toEqual(['w'])
  })

  it('a failing delivery does not stop the others', async () => {
    const { deps, gaveUp } = setup([{ sessionId: 'a', retried: false }, { sessionId: 'b', retried: false }])
    let first = true
    deps.deliver = async () => { if (first) { first = false; throw new Error('no') } return 'resumed' }
    expect(await recoverWorkers(deps)).toBe(1)
    expect(gaveUp).toEqual(['a'])
  })
})

describe('interruptedWorkers', () => {
  it('lists the workers cut off mid-turn, not archived ones or finished turns', () => {
    expect(interruptedWorkers([
      { sessionId: 'cut', turnInFlight: { retried: false }, archivedAt: null },
      { sessionId: 'again', turnInFlight: { retried: true }, archivedAt: null },
      { sessionId: 'archived', turnInFlight: { retried: false }, archivedAt: '2026-11-03T00:00:00.000Z' },
      { sessionId: 'done', turnInFlight: null, archivedAt: null },
    ])).toEqual([{ sessionId: 'cut', retried: false }, { sessionId: 'again', retried: true }])
  })
})
