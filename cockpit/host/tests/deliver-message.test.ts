import { describe, expect, it } from 'vitest'
import { deliverMessage, type DeliverMessageDeps, type MessageRequest } from '../src/application/deliver-message.js'

function setup(patch: Partial<DeliverMessageDeps> = {}) {
  const sent: string[] = []
  const deps: DeliverMessageDeps = {
    find: () => ({ sessionId: 's1', wakeable: false }),
    terminalRuns: () => false,
    runsInChat: () => true,
    chatRuns: () => false,
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
    expect(sent[0]).toBe('[Message from eml-1234]\n\nhello')
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
})
