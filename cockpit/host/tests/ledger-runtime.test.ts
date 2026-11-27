import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-keep-running-test-'))
process.env.EML_COCKPIT_HOME = home

// Remote Control is gone: a kept-running mark in an older ledger is dropped on read.
describe('an older ledger with kept sessions', () => {
  afterAll(() => rmSync(home, { recursive: true, force: true }))
  it('loads, and drops the keepRunning field', async () => {
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({ version: 1, sessions: {
      'kept-1': { createdAt: '2026-01-01T00:00:00Z', lastAttached: '2026-01-01T00:00:00Z', projectId: 'bp-eml', keepRunning: true, runtime: 'terminal' },
    } }))
    const { SessionLedger } = await import('../src/session-ledger.js')
    const entry = new SessionLedger().get('kept-1')
    expect(entry?.runtime).toBe('terminal')
    expect(entry).not.toHaveProperty('keepRunning')
  })

  it('records a new session as one in the chat; an old entry without a runtime ran in a terminal', async () => {
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({ version: 1, sessions: {
      'old-1': { createdAt: '2026-01-01T00:00:00Z', lastAttached: '2026-01-01T00:00:00Z', projectId: 'bp-eml' },
    } }))
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    expect(ledger.get('old-1')?.runtime).toBe('terminal')
    ledger.recordSpawn('new-1', null, 'bp-eml', 'claude')
    expect(ledger.get('new-1')?.runtime).toBe('sdk')
    // A respawn keeps where it ran.
    ledger.recordSpawn('old-1', null, 'bp-eml', 'claude')
    expect(ledger.get('old-1')?.runtime).toBe('terminal')
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
