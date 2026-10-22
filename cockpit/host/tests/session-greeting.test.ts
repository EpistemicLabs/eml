import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-session-greeting-test-'))
process.env.EML_COCKPIT_HOME = home

describe('session greeting', () => {
  let bridge: typeof import('../src/session-greeting.js')
  let paths: typeof import('../src/paths.js')
  const plain = { resume: false, initialPrompt: null, greet: true, worker: false }

  beforeAll(async () => {
    bridge = await import('../src/session-greeting.js')
    paths = await import('../src/paths.js')
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('opens a plain new session with the greeting when it is on', () => {
    expect(bridge.greetingFor(plain)).toBe(bridge.greetingPrompt())
  })

  it('names the session with the CLI\'s real path and the title in single quotes', () => {
    expect(bridge.TITLE_COMMAND).toBe(`node '${paths.SESSION_TITLE_CLI_JS}'`)
    expect(bridge.greetingPrompt()).toMatch(/name it in a few words: node '[^']+session-title-cli\.js' '<title>'\.$/)
    expect(bridge.greetingPrompt()).not.toContain('$COCKPIT_TITLE_JS')
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
