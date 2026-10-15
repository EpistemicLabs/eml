import { describe, it, expect } from 'vitest'
import { EML, boot, ALL_RULES } from '../src'

// v0.15 Cluster T — boot stays lean. Claude Code moves hook output above 10,000
// chars into a file that the agent then barely reads, so the boot must start
// small and agents fetch details via eml_show / eml_list / eml_get. Identity and
// behavior depend on the user's brain; the system-rules section is ours, so it
// gets a budget: adding a rule means shortening another one, or raising this
// number on purpose. The whole boot is capped by opts.budget (below).
const SYSTEM_RULES_BUDGET = 5900

// A brain at the format's limits: 2 core profiles (400), `always` always-rules
// (200) and `situational` situational rules (200 + an 80-char trigger).
function brainWith(always: number, situational: number): EML {
  const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
  eml.agents.store({ id: 'assistant', name: 'Assistant' })
  eml.users.create({ id: 'someone', name: 'Someone' })
  eml.engrams.store({ type: 'profile', scope: 'agent.assistant', title: 'assistant', content: 'A'.repeat(400) })
  eml.engrams.store({ type: 'profile', scope: 'user.someone', title: 'someone', content: 'B'.repeat(400) })
  for (let i = 0; i < always; i++) {
    eml.engrams.store({
      type: 'rule', scope: 'global', title: `always-${String(i).padStart(2, '0')}`,
      content: 'C'.repeat(200), properties: { applies: 'always' },
    })
  }
  for (let i = 0; i < situational; i++) {
    eml.engrams.store({
      type: 'rule', scope: 'global', title: `situational-${String(i).padStart(2, '0')}`,
      content: 'D'.repeat(200), properties: { applies: 'situational', trigger: 'E'.repeat(80) },
    })
  }
  return eml
}

describe('boot size budget (v0.15)', () => {
  it(`the rendered system-rules section stays within ${SYSTEM_RULES_BUDGET} chars`, () => {
    const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    try {
      const md = boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown
      const section = md.slice(md.indexOf('## EML System Rules'), md.indexOf('\n---\n'))
      expect(section.length).toBeGreaterThan(0)
      expect(section.length).toBeLessThanOrEqual(SYSTEM_RULES_BUDGET)
    } finally { eml.close() }
  })
})

describe('boot hard budget (opts.budget)', () => {
  it('renders a small brain exactly as without a budget, and reports nothing given up', () => {
    const eml = brainWith(3, 3)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      const capped = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      expect(capped.markdown).toBe(free.markdown)
      expect(free.budget).toBeUndefined()
      expect(capped.budget).toEqual({ limit: 10_000, chars: free.markdown.length, situational_title_only: 0, fits: true })
    } finally { eml.close() }
  })

  it('a full brain fits: situational rules from the last lose their trigger, nothing else changes, nothing is cut mid-text', () => {
    const eml = brainWith(8, 20)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      expect(free.markdown.length).toBeGreaterThan(10_000)
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      expect(r.markdown.length).toBeLessThanOrEqual(10_000)
      expect(r.budget).toMatchObject({ fits: true })
      const n = r.budget!.situational_title_only
      expect(n).toBeGreaterThan(0)
      expect(n).toBeLessThan(20)
      // everything up to the situational index is identical to the unbounded render
      const head = (md: string) => md.slice(0, md.indexOf('## Rules (situational'))
      expect(head(r.markdown)).toBe(head(free.markdown))
      // the last n lose their trigger, the first 20 - n keep it
      const withTrigger = r.markdown.match(/^- \*\*\[global \| situational-\d+\]\*\* when: E{80} · [0-9a-f-]{36}$/gm) ?? []
      const titleOnly = r.markdown.match(/^- \[global \| situational-(\d+)\] · [0-9a-f-]{36}$/gm) ?? []
      expect(withTrigger.length).toBe(20 - n)
      expect(titleOnly.length).toBe(n)
      expect(r.markdown).toContain('- [global | situational-19] · ')
      expect(r.markdown).toContain(`## Hints\n- ${n} entries listed by title only to fit the boot's size budget.`)
      expect(r.markdown).toContain('call eml_recall <topic> or eml_show <id>')
      // no entry cut mid-text
      expect(r.markdown).not.toMatch(/…/)
    } finally { eml.close() }
  })

  it('takes the fewest fallbacks that fit', () => {
    const eml = brainWith(2, 6)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown.length
      const at = (budget: number) => boot(eml, 'assistant', { systemRules: ALL_RULES, budget }).budget!
      expect(at(free).situational_title_only).toBe(0)
      expect(at(free - 1).situational_title_only).toBe(1)
    } finally { eml.close() }
  })

  it('never drops system rules, identity or always-rules: over the limit it reports fits=false', () => {
    const eml = brainWith(8, 3)
    try {
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 1_000 })
      expect(r.budget).toMatchObject({ limit: 1_000, fits: false, situational_title_only: 3 })
      expect(r.markdown.length).toBe(r.budget!.chars)
      expect(r.markdown).toContain('## EML System Rules')
      expect(r.markdown).toContain('A'.repeat(400))
      expect(r.markdown.match(/C{200}/g)?.length).toBe(8)
    } finally { eml.close() }
  })
})
