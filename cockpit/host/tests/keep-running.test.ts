import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-keep-running-test-'))
process.env.EML_COCKPIT_HOME = home

// Sessions reachable from the Claude app (Remote Control) keep running without
// a browser and come back after a host start, until the user closes them.

describe('kept sessions', () => {
  let ledger: import('../src/session-ledger.js').SessionLedger
  let SessionLedger: typeof import('../src/session-ledger.js').SessionLedger
  let keptSessions: typeof import('../src/pty-bridge.js').keptSessions

  beforeAll(async () => {
    ({ SessionLedger } = await import('../src/session-ledger.js'))
    ;({ keptSessions } = await import('../src/pty-bridge.js'))
    ledger = new SessionLedger()
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('remembers a kept session across a host restart, and a respawn does not drop it', () => {
    ledger.recordSpawn('kept-1', 'pane-1', 'bp-eml', 'claude')
    ledger.setKeepRunning('kept-1', true)
    ledger.recordSpawn('kept-1', 'pane-1', 'bp-eml', 'claude')
    expect(new SessionLedger().get('kept-1')?.keepRunning).toBe(true)
    expect(JSON.parse(readFileSync(join(home, 'sessions.json'), 'utf8')).sessions['kept-1'].keepRunning).toBe(true)
  })

  it('is not kept once it is no longer marked, and old entries are not kept', () => {
    ledger.recordSpawn('plain-1', 'pane-2', 'bp-eml', 'claude')
    expect(ledger.get('plain-1')?.keepRunning).toBe(false)
    ledger.setKeepRunning('kept-1', false)
    expect(new SessionLedger().get('kept-1')?.keepRunning).toBe(false)
  })

  it('brings back kept sessions on a host start, never workers', () => {
    const entries = [
      { sessionId: 'a', keepRunning: true, worker: false },
      { sessionId: 'b', keepRunning: false, worker: false },
      { sessionId: 'c', keepRunning: true, worker: true },
    ]
    expect(keptSessions(entries).map((e) => e.sessionId)).toEqual(['a'])
  })
})

describe('one process per conversation', () => {
  it('finds a conversation running under another pane of the same space only', async () => {
    const { runningEntry } = await import('../src/pty-bridge.js')
    const sessions = new Map([
      ['main_bp-eml_s1_pane_old', { sessionId: 's1', spaceId: 'main' }],
      ['other_bp-eml_s2_pane_x', { sessionId: 's2', spaceId: 'other' }],
    ])
    expect(runningEntry(sessions, 'main', 's1')?.[0]).toBe('main_bp-eml_s1_pane_old')
    expect(runningEntry(sessions, 'main', 's2')).toBeNull()
    expect(runningEntry(sessions, 'main', 's3')).toBeNull()
  })
})
