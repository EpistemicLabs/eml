import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the host modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-project-lead-'))
process.env.EML_COCKPIT_HOME = home

// The project lead: one per project and day, found again the same day, a new
// one the next; it gets no task of its own and leaves the project's status.

describe('project lead', () => {
  let lead: typeof import('../src/domain/project-lead.js')
  let SessionLedger: typeof import('../src/session-ledger.js')['SessionLedger']
  let createSessionTask: typeof import('../src/application/session-task.js')['createSessionTask']
  beforeAll(async () => {
    lead = await import('../src/domain/project-lead.js')
    SessionLedger = (await import('../src/session-ledger.js')).SessionLedger
    createSessionTask = (await import('../src/application/session-task.js')).createSessionTask
  })
  afterAll(() => rmSync(home, { recursive: true, force: true }))

  it('takes the day in the user\'s time zone', () => {
    expect(lead.leadDay(new Date('2026-11-17T20:00:00Z'), 'Asia/Singapore')).toBe('2026-11-18')
    expect(lead.leadDay(new Date('2026-11-17T20:00:00Z'), 'UTC')).toBe('2026-11-17')
  })

  it('briefs the lead to read, propose and wait, and to leave the status', () => {
    const text = lead.leadPrompt({ name: 'Website', brainId: 'website' }, '2026-11-18')
    expect(text).toContain('project lead of "Website" for today, 2026-11-18')
    expect(text).toContain('eml_show project.website')
    expect(text).toContain('Do not start anything before he does')
    expect(text).toContain('eml_set_status scope=project.website')
    expect(text).not.toMatch(/\n\n\n/)
  })

  it('finds today\'s lead once expected and once started, not tomorrow\'s; it gets no task and hands off the status', async () => {
    const ledger = new SessionLedger()
    ledger.expectLead('lead-1', { projectId: 'bp-website', day: '2026-11-18' })
    expect(ledger.leadFor('bp-website', '2026-11-18', null)).toBe('lead-1')
    ledger.recordSpawn('lead-1', 'pane', 'bp-website', 'claude')
    const posts: unknown[] = []
    const tasks = createSessionTask({
      ledger, spaces: { resolve: () => ({ shared: false }) as never }, me: 'kim', endTurnTool: () => true,
      brain: () => ({ get: async () => ({}), post: async (...a: unknown[]) => { posts.push(a); return { id: 'x' } } }),
    })
    expect(await tasks.context('lead-1')).toBe('')
    expect(posts).toEqual([])
    expect(ledger.get('lead-1')!.leadOf).toEqual({ projectId: 'bp-website', day: '2026-11-18' })
    expect(ledger.leadFor('bp-website', '2026-11-18', null)).toBe('lead-1')
    expect(ledger.leadFor('bp-website', '2026-11-19', null)).toBeNull()
    expect(tasks.handoffBeforeStop('lead-1')).toBe(lead.LEAD_HANDOFF)
    // It survives a respawn and a reload.
    ledger.recordSpawn('lead-1', 'pane', 'bp-website', 'claude')
    expect(new SessionLedger().get('lead-1')!.leadOf).toEqual({ projectId: 'bp-website', day: '2026-11-18' })
  })

  it('forgets a lead that did not start, so the next ask starts a new one', () => {
    const ledger = new SessionLedger()
    ledger.expectLead('lead-2', { projectId: 'bp-shop', day: '2026-11-18' })
    expect(ledger.leadFor('bp-shop', '2026-11-18', null)).toBe('lead-2')
    ledger.dropExpectedLead('lead-2')
    expect(ledger.leadFor('bp-shop', '2026-11-18', null)).toBeNull()
  })
})
