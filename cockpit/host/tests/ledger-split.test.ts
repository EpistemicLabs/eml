import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { launchesUnattended, unattended } from '../src/domain/spawn-request.js'

// paths.ts reads the home at import time — set it before loading the ledger.
process.env.EML_COCKPIT_HOME = mkdtempSync(join(tmpdir(), 'cockpit-ledger-split-'))

describe('a session split off another one', () => {
  it('is the user\'s own session that remembers where it came from', async () => {
    const { SessionLedger } = await import('../src/session-ledger.js')
    const ledger = new SessionLedger()
    ledger.expectParent('split', 'source')
    ledger.expectOwn('split')
    ledger.recordSpawn('split', 'pane', 'bp-ui', 'claude', true, 't-new', null)
    expect(ledger.get('split')).toMatchObject({ worker: false, parentSessionId: 'source', taskId: 't-new' })
    ledger.expectParent('worker', 'source')
    ledger.recordSpawn('worker', null, 'bp-ui', 'claude', true, null, null)
    expect(ledger.get('worker')!.worker).toBe(true)
  })

  it('does not run unattended, though another session asked for it', () => {
    expect(unattended({ fromSessionId: 'source', origin: 'split' })).toBe(false)
    expect(unattended({ fromSessionId: 'source' })).toBe(true)
    expect(unattended({ fromSessionId: null, origin: 'task' })).toBe(false)
  })

  it('launches attended in a terminal though it starts with a prompt', () => {
    expect(launchesUnattended({ worker: false, initialPrompt: true, own: true })).toBe(false)
    expect(launchesUnattended({ worker: false, initialPrompt: true, own: false })).toBe(true)
    expect(launchesUnattended({ worker: true, initialPrompt: false, own: false })).toBe(true)
    expect(launchesUnattended({ worker: false, initialPrompt: false, own: false })).toBe(false)
  })
})
