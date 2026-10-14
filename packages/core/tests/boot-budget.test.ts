import { describe, it, expect } from 'vitest'
import { EML, boot, ALL_RULES } from '../src'

// v0.15 Cluster T — boot stays lean. Claude Code moves hook output above 10,000
// chars into a file that the agent then barely reads, so the boot must start
// small and agents fetch details via eml_show / eml_list / eml_get. Identity and
// behavior depend on the user's brain; the system-rules section is ours, so it
// gets a budget: adding a rule means shortening another one, or raising this
// number on purpose. The whole boot is capped by opts.budget (below).
const SYSTEM_RULES_BUDGET = 5900

function brainWith(profiles: number, rules: number, chars: number, profileChars = 300): EML {
  const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
  eml.agents.store({ id: 'assistant', name: 'Assistant' })
  eml.users.create({ id: 'someone', name: 'Someone' })
  for (let i = 0; i < profiles; i++) {
    eml.engrams.store({
      type: 'profile', scope: i === 0 ? 'agent.assistant' : 'user.someone', title: `profile-${i}`,
      content: `P${i} `.repeat(profileChars / 3), properties: { boot: ['*'] },
    })
  }
  for (let i = 0; i < rules; i++) {
    eml.engrams.store({
      type: 'rule', scope: 'global', title: `rule-${i}`,
      content: `R${i} `.repeat(chars / 3), properties: { applies: 'always', boot: ['*'] },
    })
  }
  return eml
}

describe('boot size budget (v0.15)', () => {
  it(`the rendered system-rules section stays within ${SYSTEM_RULES_BUDGET} chars`, () => {
    const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    try {
      const md = boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown
      const section = md.slice(md.indexOf('## EML System Rules'))
      expect(section.length).toBeGreaterThan(0)
      expect(section.length).toBeLessThanOrEqual(SYSTEM_RULES_BUDGET)
    } finally { eml.close() }
  })
})

describe('boot hard budget (opts.budget)', () => {
  it('renders a small brain exactly as without a budget, and reports nothing trimmed', () => {
    const eml = brainWith(2, 3, 300)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      const capped = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      expect(capped.markdown).toBe(free.markdown)
      expect(free.budget).toBeUndefined()
      expect(capped.budget).toEqual({
        limit: 10_000, chars: free.markdown.length, rule_cap: 600,
        rules_named_only: 0, profiles_named_only: 0, fits: true,
      })
    } finally { eml.close() }
  })

  it('an oversized brain fits the budget: rules shortened, then named only, system rules and footer intact', () => {
    // 20 rules x 1,500 chars + 5 profiles x 300 chars: ~18,000 chars unbounded (rules cut at 600).
    const eml = brainWith(5, 20, 1500)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      expect(free.markdown.length).toBeGreaterThan(10_000)
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      expect(r.markdown.length).toBeLessThanOrEqual(10_000)
      expect(r.budget?.fits).toBe(true)
      expect(r.budget?.rule_cap).toBe(250)
      expect(r.budget?.rules_named_only).toBeGreaterThan(0)
      expect(r.budget?.profiles_named_only).toBe(0)
      // system rules byte-identical to the unbounded render
      const sys = (md: string) => md.slice(md.indexOf('## EML System Rules'), md.indexOf('\n---\n'))
      expect(sys(r.markdown)).toBe(sys(free.markdown))
      // the footer keeps the recall pointer and explains the trim
      expect(r.markdown).toContain('call eml_recall <topic> or eml_show <id>')
      expect(r.markdown).toMatch(/_Boot trimmed to the hook's size budget: behavior rules cut at 250 chars, \d+ rule\(s\) listed by name only — eml_get <id> returns the full text\._$/)
      // a named-only rule shows scope | title and its id, nothing of its body;
      // the others are there, shortened
      const named = r.markdown.match(/- \*\*\[global \| rule-\d+\]\*\* _\(full text: eml_get [0-9a-f-]{36}\)_/g) ?? []
      expect(named.length).toBe(r.budget!.rules_named_only)
      const shortened = r.markdown.match(/- \*\*\[global \| rule-\d+\]\*\* R\d+ .*…$/gm) ?? []
      expect(shortened.length).toBe(20 - r.budget!.rules_named_only)
    } finally { eml.close() }
  })

  it('walks the ladder: 400 before 250, 250 before naming, profiles last', () => {
    const eml = brainWith(2, 6, 700)
    try {
      const at = (budget: number) => boot(eml, 'assistant', { systemRules: ALL_RULES, budget }).budget!
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown.length
      expect(at(free).rule_cap).toBe(600)
      expect(at(free - 1).rule_cap).toBe(400)
      const at400 = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: free - 1 }).markdown.length
      expect(at(at400 - 1)).toMatchObject({ rule_cap: 250, rules_named_only: 0 })
      const at250 = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: at400 - 1 }).markdown.length
      expect(at(at250 - 1)).toMatchObject({ rule_cap: 250, rules_named_only: 1, profiles_named_only: 0 })
      // everything named: profiles go only after all rules
      const allRulesNamed = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 5_600 }).budget!
      expect(allRulesNamed.rules_named_only).toBe(6)
      expect(allRulesNamed.profiles_named_only).toBeGreaterThan(0)
    } finally { eml.close() }
  })

  it('reports fits=false and still returns the last rung when nothing fits', () => {
    const eml = brainWith(1, 1, 100)
    try {
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 100 })
      expect(r.budget).toMatchObject({ limit: 100, fits: false, rule_cap: 250, rules_named_only: 1, profiles_named_only: 1 })
      expect(r.markdown).toContain('## EML System Rules')
      expect(r.markdown.length).toBe(r.budget!.chars)
    } finally { eml.close() }
  })
})
