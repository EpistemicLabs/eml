import { describe, expect, it } from 'vitest'
import { SessionHandoff, type HandoffSide } from '../src/application/session-handoff.js'

/** A side whose `end` finishes when the test says so, recording who ran when. */
function side(name: string, trace: string[]) {
  const running = new Set<string>()
  let finish: (() => void) | null = null
  const handoffSide: HandoffSide = {
    isRunning: (id) => running.has(id),
    end: (id) => new Promise<void>((resolve) => {
      trace.push(`${name}:ending`)
      finish = () => { running.delete(id); trace.push(`${name}:ended`); resolve() }
    }),
  }
  return { handoffSide, running, finish: () => finish?.() }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('SessionHandoff', () => {
  it('starts right away when nothing else holds the session', () => {
    const trace: string[] = []
    const handoff = new SessionHandoff({ terminal: side('t', trace).handoffSide, sdk: side('s', trace).handoffSide })
    let started = false
    void handoff.enter('terminal', 'a', () => { started = true })
    expect(started).toBe(true)
    expect(handoff.switching('a')).toBe(false)
  })

  it('starts only after the other side has exited', async () => {
    const trace: string[] = []
    const terminal = side('t', trace)
    const handoff = new SessionHandoff({ terminal: terminal.handoffSide, sdk: side('s', trace).handoffSide })
    terminal.running.add('a')
    const entered = handoff.enter('sdk', 'a', () => { trace.push('s:start') })
    await tick()
    expect(trace).toEqual(['t:ending'])
    expect(handoff.switching('a')).toBe(true)
    terminal.finish()
    await entered
    expect(trace).toEqual(['t:ending', 't:ended', 's:start'])
    await tick()
    expect(handoff.switching('a')).toBe(false)
  })

  it('a quick switch back waits its turn instead of overlapping', async () => {
    const trace: string[] = []
    const terminal = side('t', trace)
    const sdk = side('s', trace)
    const handoff = new SessionHandoff({ terminal: terminal.handoffSide, sdk: sdk.handoffSide })
    terminal.running.add('a')
    const toChat = handoff.enter('sdk', 'a', () => { sdk.running.add('a'); trace.push('s:start') })
    const toTerminal = handoff.enter('terminal', 'a', () => { terminal.running.add('a'); trace.push('t:start') })
    await tick()
    terminal.finish()
    await toChat
    await tick()
    expect(trace).toEqual(['t:ending', 't:ended', 's:start', 's:ending'])
    sdk.finish()
    await toTerminal
    expect(trace.at(-1)).toBe('t:start')
    expect([...terminal.running, ...sdk.running]).toEqual(['a'])
  })

  it('a failed entry does not block the next one', async () => {
    const trace: string[] = []
    const handoff = new SessionHandoff({ terminal: side('t', trace).handoffSide, sdk: side('s', trace).handoffSide })
    await expect(handoff.enter('sdk', 'a', async () => { throw new Error('no') })).rejects.toThrow('no')
    await tick()
    let started = false
    await handoff.enter('sdk', 'a', () => { started = true })
    expect(started).toBe(true)
  })

  it('sessions do not wait for each other', async () => {
    const trace: string[] = []
    const terminal = side('t', trace)
    const handoff = new SessionHandoff({ terminal: terminal.handoffSide, sdk: side('s', trace).handoffSide })
    terminal.running.add('a')
    void handoff.enter('sdk', 'a', () => {})
    let started = false
    void handoff.enter('sdk', 'b', () => { started = true })
    expect(started).toBe(true)
  })
})
