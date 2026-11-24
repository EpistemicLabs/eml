import { describe, it, expect } from 'vitest'
import { createStartGate, START_WINDOW_MS } from '../src/application/start-gate.js'

describe('start gate', () => {
  it('gives parallel starts on the same task one session', async () => {
    let n = 0
    const gate = createStartGate<{ ok: boolean; id: number }>()
    const start = () => new Promise<{ ok: boolean; id: number }>((resolve) => setTimeout(() => resolve({ ok: true, id: ++n }), 5))
    const answers = await Promise.all(Array.from({ length: 6 }, () => gate('space:t1:', start)))
    expect(n).toBe(1)
    expect(new Set(answers.map((a) => a.id))).toEqual(new Set([1]))
  })

  it('lets another task, another prompt, a start after the window, and a retry after a refusal through', async () => {
    let clock = 0
    let n = 0
    const gate = createStartGate<{ ok: boolean }>(() => clock)
    const ok = async () => { n++; return { ok: true } }
    await gate('a', ok)
    await gate('b', ok)
    await gate('a:other prompt', ok)
    expect(n).toBe(3)
    await gate('a', ok)
    expect(n).toBe(3)
    clock += START_WINDOW_MS
    await gate('a', ok)
    expect(n).toBe(4)
    await gate('c', async () => { n++; return { ok: false } })
    await gate('c', ok)
    expect(n).toBe(6)
  })
})
