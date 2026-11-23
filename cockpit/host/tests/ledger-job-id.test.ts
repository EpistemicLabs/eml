import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-ledger-job-'))

// A job's session keeps the job it runs for across resumes and host restarts:
// its channel tools and its draft card are found by it.
describe('ledger job id', () => {
  it('is kept on the session, through a respawn and a reload', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, null, null)
    expect(ledger.get('s1')!.jobId).toBeNull()
    ledger.setJobId('s1', 'job-1')
    ledger.recordSpawn('s1', 'pane', 'bp-eml', 'claude', true, null, null)
    expect(ledger.get('s1')!.jobId).toBe('job-1')
    expect(new SessionLedger().get('s1')!.jobId).toBe('job-1')
  })
})
