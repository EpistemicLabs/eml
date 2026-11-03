import { describe, expect, it } from 'vitest'
import { deliverMessage, type DeliverMessageDeps, type MessageRequest } from '../src/application/deliver-message.js'
import { requestMessage } from '../src/spawn-api.js'

function setup(patch: Partial<DeliverMessageDeps> = {}) {
  const sent: string[] = []
  const deps: DeliverMessageDeps = {
    find: () => ({ sessionId: 's1', wakeable: false }),
    terminalRuns: () => false,
    runsInChat: () => true,
    chatRuns: () => false,
    sameReach: () => true,
    deliver: async (_id, text) => { sent.push(text); return 'resumed' },
    ...patch,
  }
  return { deps, sent }
}

const request: MessageRequest = { target: 's1', text: 'hello', from: null, caller: 'session' }

describe('deliverMessage', () => {
  it('hands the message on and reports what came of it', async () => {
    const { deps, sent } = setup()
    expect(await deliverMessage(deps, request)).toBe('resumed')
    expect(sent).toEqual(['hello'])
  })

  it('says who it is from', async () => {
    const { deps, sent } = setup()
    await deliverMessage(deps, { ...request, from: 'eml-1234' })
    expect(sent[0]).toBe('[Message from eml-1234, another session, not your user. To answer, use SendMessage to eml-1234.]\n\nhello')
    const wakeable = setup({ find: () => ({ sessionId: 's1', wakeable: true }) })
    await deliverMessage(wakeable.deps, { ...request, from: 'bridge', caller: 'outside' })
    expect(wakeable.sent[0]).toBe('[Message from bridge]\n\nhello')
  })

  it('an unknown session is unknown', async () => {
    expect(await deliverMessage(setup({ find: () => null }).deps, request)).toBe('unknown')
  })

  it('an outside service only reaches wakeable sessions', async () => {
    expect(await deliverMessage(setup().deps, { ...request, caller: 'outside' })).toBe('refused')
    const wakeable = setup({ find: () => ({ sessionId: 's1', wakeable: true }) })
    expect(await deliverMessage(wakeable.deps, { ...request, caller: 'outside' })).toBe('resumed')
  })

  it('a session in a terminal is busy, and gets nothing', async () => {
    const { deps, sent } = setup({ terminalRuns: () => true })
    expect(await deliverMessage(deps, request)).toBe('busy')
    expect(sent).toEqual([])
  })

  it('a stopped session that cannot run in chat is refused; a running one is not', async () => {
    expect(await deliverMessage(setup({ runsInChat: () => false }).deps, request)).toBe('refused')
    expect(await deliverMessage(setup({ runsInChat: () => false, chatRuns: () => true }).deps, request)).toBe('resumed')
  })

  describe('only if stopped (the SendMessage hook)', () => {
    const stoppedOnly = { ...request, onlyIfStoppedFor: 's2' }

    it('a stopped session gets it', async () => {
      const { deps, sent } = setup()
      expect(await deliverMessage(deps, stoppedOnly)).toBe('resumed')
      expect(sent).toEqual(['hello'])
    })

    it('a running session, chat or terminal, gets nothing from here', async () => {
      for (const running of [{ chatRuns: () => true }, { terminalRuns: () => true }]) {
        const { deps, sent } = setup(running)
        expect(await deliverMessage(deps, stoppedOnly)).toBe('running')
        expect(sent).toEqual([])
      }
    })

    it('a session SendMessage could not reach while running counts as unknown and stays asleep', async () => {
      const reach: Array<[string, string]> = []
      const { deps, sent } = setup({ sameReach: (from, to) => { reach.push([from, to]); return false } })
      expect(await deliverMessage(deps, stoppedOnly)).toBe('unknown')
      expect(reach).toEqual([['s2', 's1']])
      expect(sent).toEqual([])
    })

    it('without the hook the reach does not matter', async () => {
      expect(await deliverMessage(setup({ sameReach: () => false }).deps, request)).toBe('resumed')
    })

    it('a stopped session that cannot run in chat is still refused', async () => {
      expect(await deliverMessage(setup({ runsInChat: () => false }).deps, stoppedOnly)).toBe('refused')
    })
  })
})

describe('requestMessage', () => {
  it('passes on only-if-stopped, and a running session is a conflict', async () => {
    const seen: MessageRequest[] = []
    const deliver = async (message: MessageRequest) => { seen.push(message); return 'running' as const }
    const answer = await requestMessage({ deliver }, 'session', 'eml-1', { text: 'hello', from: 'eml-2', onlyIfStoppedFor: 's2' })
    expect(answer).toEqual({ status: 409, payload: { outcome: 'running' } })
    expect(seen).toEqual([{ target: 'eml-1', text: 'hello', from: 'eml-2', caller: 'session', onlyIfStoppedFor: 's2' }])
    await requestMessage({ deliver }, 'session', 'eml-1', { text: 'hello' })
    expect(seen[1]).not.toHaveProperty('onlyIfStoppedFor')
  })
})
