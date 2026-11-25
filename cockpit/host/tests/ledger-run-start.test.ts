import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-ledger-run-start-'))

// A session a delegation continued keeps when its current run started across respawns and host restarts:
// its run's id and start come from it, and the runner counts the request as started by it.
describe('ledger run start', () => {
  it('is null for a session\'s first run, and kept through a respawn and a reload once a delegation continued it', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', false, 't1', null)
    expect(ledger.get('s1')!.runStartedAt).toBeNull()
    ledger.startRun('s1', '2026-11-25T10:00:00.000Z')
    ledger.recordSpawn('s1', 'pane', 'bp-eml', 'claude', false, null, null)
    expect(ledger.get('s1')!.runStartedAt).toBe('2026-11-25T10:00:00.000Z')
    expect(new SessionLedger().get('s1')!.runStartedAt).toBe('2026-11-25T10:00:00.000Z')
    ledger.startRun('nobody', '2026-11-25T10:00:00.000Z')
    expect(new SessionLedger().get('nobody')).toBeUndefined()
  })
})
