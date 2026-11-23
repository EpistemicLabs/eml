import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-ledger-profile-'))

// The user lifted a session's limits: they stay lifted on every resume and after a host restart.
describe('ledger tool profile', () => {
  it('is cleared for good, through a respawn and a reload', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, null, null)
    ledger.setToolProfile('s1', { deniedTools: ['mcp__gmail__send_email'], mcpServers: null })
    expect(new SessionLedger().get('s1')!.toolProfile).toEqual({ deniedTools: ['mcp__gmail__send_email'], mcpServers: null })
    ledger.clearToolProfile('s1')
    expect(new SessionLedger().get('s1')!.toolProfile).toBeNull()
    ledger.recordSpawn('s1', 'pane', 'bp-eml', 'claude', true, null, null)
    expect(ledger.get('s1')!.toolProfile).toBeNull()
    expect(new SessionLedger().get('s1')!.toolProfile).toBeNull()
  })

  it('does nothing for a session it does not know', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.clearToolProfile('unknown')
    expect(ledger.get('unknown')).toBeUndefined()
  })
})
