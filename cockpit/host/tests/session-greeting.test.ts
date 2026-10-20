import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-greeting-test-'))
process.env.EML_COCKPIT_HOME = home

describe('session greeting', () => {
  let bridge: typeof import('../src/pty-bridge.js')
  const plain = { resume: false, initialPrompt: null, greet: true, worker: false }

  beforeAll(async () => { bridge = await import('../src/pty-bridge.js') })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('opens a plain new session with the greeting when it is on', () => {
    expect(bridge.greetingFor(plain)).toBe(bridge.GREETING_PROMPT)
  })

  it('stays silent when it is off', () => {
    expect(bridge.greetingFor({ ...plain, greet: false })).toBeNull()
  })

  it('never greets a resumed session', () => {
    expect(bridge.greetingFor({ ...plain, resume: true })).toBeNull()
  })

  it('leaves a session with its own first prompt alone (task run, hygiene, onboarding)', () => {
    expect(bridge.greetingFor({ ...plain, initialPrompt: 'Use the task-run skill for task x' })).toBeNull()
  })

  it('never greets a worker', () => {
    expect(bridge.greetingFor({ ...plain, worker: true })).toBeNull()
  })
})
