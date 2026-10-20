import { describe, it, expect } from 'vitest'
import { projectBlockHook, trimSummary, PROJECT_BLOCK_BUDGET_CHARS } from '../src/hooks/project-block'

const CFG = { EML_URL: 'http://brain.test', EML_API_TOKEN: 't' }
const ENV = { EML_PROJECT_SCOPE: 'project.demo' }
const BUDGET = {
  limit: 10_000, chars: 40, tasks_title_only: 0, tasks_left_out: 0, log_left_out: false,
  situational_title_only: 0, always_title_only: 0, rules_left_out: 0, fits: true,
}

function fakeBrain(status = 200, seen: Array<{ url: string; body: unknown }> = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    seen.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) })
    if (status !== 200) return new Response(JSON.stringify({ error: 'x' }), { status })
    return new Response(JSON.stringify({ markdown: '# Project — project.demo (Demo)', open_tasks: 3, pending_reviews: 1, legacy: 0, budget: BUDGET }), { status: 200 })
  }) as typeof fetch
}

describe('hook project-block', () => {
  it('delivers the block for EML_PROJECT_SCOPE within the Claude Code budget', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    const r = await projectBlockHook(CFG, { source: 'startup' }, ENV, fakeBrain(200, seen))
    expect(r.output).toBe('# Project — project.demo (Demo)')
    expect(r.log).toMatch(/OK project\.demo startup chars=\d+ trim=none tasks=3 reviews=1 legacy=0/)
    expect(seen[0]).toEqual({ url: 'http://brain.test/project-block', body: { scope: 'project.demo', budget: PROJECT_BLOCK_BUDGET_CHARS } })
  })

  it('delivers on every session start source — it keeps no state', async () => {
    for (const source of ['startup', 'resume', 'compact', 'clear', 'startup']) {
      const r = await projectBlockHook(CFG, { source }, ENV, fakeBrain())
      expect(r.output, source).toContain('# Project')
      expect(r.log).toContain(` ${source} `)
    }
  })

  it('is silent without a project scope — it never guesses one from the working directory', async () => {
    const seen: Array<{ url: string; body: unknown }> = []
    for (const env of [{}, { EML_PROJECT_SCOPE: 'global' }, { EML_PROJECT_SCOPE: 'project.x; rm' }]) {
      expect((await projectBlockHook(CFG, { source: 'startup' }, env, fakeBrain(200, seen))).output).toBe('')
    }
    expect(seen).toHaveLength(0)
  })

  it('says nothing for a project the brain does not know', async () => {
    const r = await projectBlockHook(CFG, { source: 'startup' }, ENV, fakeBrain(404))
    expect(r).toEqual({ output: '', log: 'project-block: no project project.demo in the brain (startup)' })
  })

  it('stays silent on a failure or without a config', async () => {
    const down = (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch
    expect((await projectBlockHook(CFG, { source: 'startup' }, ENV, down)).output).toBe('')
    expect((await projectBlockHook(CFG, { source: 'startup' }, ENV, fakeBrain(500))).output).toBe('')
    expect((await projectBlockHook(null, { source: 'startup' }, ENV, fakeBrain())).output).toBe('')
  })
})

describe('trimSummary', () => {
  it('names what gave way, per kind', () => {
    expect(trimSummary(BUDGET)).toBe('trim=none')
    expect(trimSummary({ ...BUDGET, tasks_title_only: 10, tasks_left_out: 2, log_left_out: true })).toBe('trim=tasks_title_only:10,tasks_left_out:2,log_left_out:1')
    expect(trimSummary({ ...BUDGET, fits: false })).toBe('trim=OVER-BUDGET limit=10000')
    expect(trimSummary(undefined)).toBe('trim=unknown')
  })
})
