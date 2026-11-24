import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-ledger-unarchive-'))

// An archived session that later asks for someone comes back into the lists.
describe('ledger: attention after archive', () => {
  it.each(['question', 'review', 'failed'] as const)('%s brings an archived session back', async (kind) => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    const id = `s-${kind}`
    ledger.recordSpawn(id, null, 'bp-eml', 'claude', true, null, null)
    ledger.archive(id)
    expect(ledger.get(id)!.archivedAt).not.toBeNull()
    ledger.setAttention(id, { kind, reason: 'A or B?' })
    expect(ledger.get(id)).toMatchObject({ archivedAt: null, attention: { kind, reason: 'A or B?' } })
    expect(new SessionLedger().get(id)!.archivedAt).toBeNull()
  })

  it('done, or clearing the flag, leaves it archived', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.recordSpawn('s-done', null, 'bp-eml', 'claude', true, null, null)
    ledger.archive('s-done')
    ledger.setAttention('s-done', { kind: 'done', reason: 'Rescheduled.' })
    expect(ledger.get('s-done')!.archivedAt).not.toBeNull()
    ledger.setAttention('s-done', null)
    expect(ledger.get('s-done')!.archivedAt).not.toBeNull()
  })
})
