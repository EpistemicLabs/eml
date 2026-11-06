import { describe, expect, it, vi } from 'vitest'
import { shutDownOnSignal, type ShutDownDeps } from '../src/application/shut-down.js'

function setup(drain: () => Promise<void>) {
  const steps: string[] = []
  const deps: ShutDownDeps = {
    stop: () => { steps.push('stop') },
    drain: () => { steps.push('drain'); return drain().then(() => { steps.push('drained') }) },
    last: () => { steps.push('last') },
    exit: (code) => { steps.push(`exit ${code}`) },
    log: () => {},
  }
  return { deps, steps }
}

describe('shutDownOnSignal', () => {
  it('waits for the sessions to close, then exits', async () => {
    let finish!: () => void
    const { deps, steps } = setup(() => new Promise<void>((resolve) => { finish = resolve }))
    const done = shutDownOnSignal(deps, 1_000)()
    await Promise.resolve()
    expect(steps).toEqual(['stop', 'drain'])
    finish()
    await done
    expect(steps).toEqual(['stop', 'drain', 'drained', 'last', 'exit 0'])
  })

  it('a session that never closes does not hold up the exit', async () => {
    vi.useFakeTimers()
    const { deps, steps } = setup(() => new Promise<void>(() => {}))
    const done = shutDownOnSignal(deps, 1_000)()
    await vi.advanceTimersByTimeAsync(999)
    expect(steps).not.toContain('exit 0')
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(steps).toEqual(['stop', 'drain', 'last', 'exit 0'])
    vi.useRealTimers()
  })

  it('a failing close still exits, and a second signal exits at once', async () => {
    const { deps, steps } = setup(() => Promise.reject(new Error('gone')))
    const shutdown = shutDownOnSignal(deps, 1_000)
    const first = shutdown()
    await shutdown()
    expect(steps).toContain('exit 0')
    await first
    expect(steps.filter((step) => step === 'exit 0')).toHaveLength(2)
  })
})
