import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-ledger-read-'))

// The Inbox's Mark all read can be undone: the session gets back the read state it had.
describe('ledger read state', () => {
  it('markRead clears the result; restoreRead puts both back, also after a reload', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('s1', null, 'bp-eml', 'claude', true, null, null)
    ledger.setAttention('s1', { kind: 'done', reason: 'Report ready.' })
    ledger.setResult('s1', true)
    const before = { readAt: ledger.get('s1')!.readAt, resultAt: ledger.get('s1')!.resultAt }
    expect(before.resultAt).not.toBeNull()

    ledger.markRead('s1')
    expect(ledger.get('s1')!.readAt).not.toBeNull()
    expect(ledger.get('s1')!.resultAt).toBeNull()

    expect(ledger.restoreRead('s1', before)).toBe(true)
    expect(ledger.get('s1')!.readAt).toBe(before.readAt)
    expect(ledger.get('s1')!.resultAt).toBe(before.resultAt)
    expect(new SessionLedger().get('s1')!.resultAt).toBe(before.resultAt)
  })

  it('keeps a newer answer: a turn that ended or reported after the read is not undone', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('s2', null, 'bp-eml', 'claude', true, null, null)
    ledger.setResult('s2', true)
    const before = { readAt: null, resultAt: ledger.get('s2')!.resultAt }
    ledger.markRead('s2')
    ledger.setResult('s2', true)
    const newer = ledger.get('s2')!.resultAt
    expect(ledger.restoreRead('s2', before)).toBe(false)
    expect(ledger.get('s2')!.resultAt).toBe(newer)

    ledger.recordSpawn('s3', null, 'bp-eml', 'claude', true, null, null)
    ledger.markRead('s3')
    ledger.get('s3')!.readAt = '2000-01-01T00:00:00.000Z'
    ledger.setAttention('s3', { kind: 'done', reason: 'Again.' })
    expect(ledger.restoreRead('s3', { readAt: null, resultAt: null })).toBe(false)
  })

  it('ignores a session it does not know', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    expect(ledger.restoreRead('nope', { readAt: null, resultAt: null })).toBe(false)
    expect(ledger.get('nope')).toBeUndefined()
  })
})
