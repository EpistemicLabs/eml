import { describe, it, expect } from 'vitest'
import { blockedLine, requestLabel, watchLoop } from '../src/loop-watch'

// The loop watch (loop-watch.ts), with a clock and a timer the test moves.

function setup() {
  let t = 0
  let tick: () => void = () => {}
  let stopped = false
  const lines: string[] = []
  const watch = watchLoop({
    log: (line) => lines.push(line),
    now: () => t,
    every: (fn) => { tick = fn; return () => { stopped = true } },
  })
  /** The timer fires `ms` after its last firing. */
  const fire = (ms: number) => { t += ms; tick() }
  return { watch, fire, lines, stopped: () => stopped }
}

describe('watchLoop', () => {
  it('says nothing while the timer fires on time', () => {
    const { fire, lines } = setup()
    fire(250); fire(251); fire(900)
    expect(lines).toEqual([])
  })

  it('says how long the thread was blocked, and the request that ran last', () => {
    const { watch, fire, lines } = setup()
    fire(250)
    watch.enter(requestLabel('GET', '/list?type=task&search=secret', 'b1'))
    watch.enter(requestLabel('GET', '/hygiene', '5fa3766c-160c-4fca-b4f2-d38a0d782a24'))
    fire(250 + 18_000)
    expect(lines).toEqual(['[loop] the request thread was blocked for 18000 ms (last request: GET /hygiene · 5fa3766c-160c-4fca-b4f2-d38a0d782a24)'])
    // measured from the late firing on: the next one on time is quiet
    fire(250)
    expect(lines).toHaveLength(1)
  })

  it('leaves blocks under a second out', () => {
    const { fire, lines } = setup()
    fire(250 + 999)
    expect(lines).toEqual([])
    fire(250 + 1000)
    expect(lines).toHaveLength(1)
  })

  it('stops its timer', () => {
    const { watch, stopped } = setup()
    watch.stop()
    expect(stopped()).toBe(true)
  })
})

describe('requestLabel', () => {
  it('names the method, the path without its query, and the brain by its id', () => {
    expect(requestLabel('GET', '/list?search=secret', '5fa3766c')).toBe('GET /list · 5fa3766c')
    expect(requestLabel(undefined, '/health')).toBe('GET /health')
  })
})

describe('blockedLine', () => {
  it('names no request when none ran yet', () => {
    expect(blockedLine(1234.4, null)).toBe('[loop] the request thread was blocked for 1234 ms')
  })
})
