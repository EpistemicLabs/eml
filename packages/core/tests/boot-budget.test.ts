import { describe, it, expect } from 'vitest'
import { EML, boot, ALL_RULES } from '../src'

// v0.15 Cluster T — boot stays lean. Claude Code moves hook output above 10,000
// chars into a file that the agent then barely reads, so the boot must start
// small and agents fetch details via eml_show / eml_list / eml_get. Identity and
// behavior depend on the user's brain; the system-rules section is ours, so it
// gets a budget: adding a rule means shortening another one, or raising this
// number on purpose. The whole boot is capped by opts.budget (below).
const SYSTEM_RULES_BUDGET = 5900

// A brain at the format's limits: core profiles (400) of the agent and of
// `users` users, `always` always-rules (200) and `situational` situational
// rules (200 + an 80-char trigger).
function brainWith(always: number, situational: number, users = 1): EML {
  const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
  eml.agents.store({ id: 'assistant', name: 'Assistant' })
  eml.engrams.store({ type: 'profile', scope: 'agent.assistant', title: 'assistant', content: 'A'.repeat(400), properties: { core: true } })
  for (let u = 0; u < users; u++) {
    const id = `user${u}`
    eml.users.create({ id, name: id })
    eml.engrams.store({ type: 'profile', scope: `user.${id}`, title: id, content: 'B'.repeat(400), properties: { core: true } })
  }
  for (let i = 0; i < always; i++) {
    eml.engrams.store({
      type: 'rule', scope: 'global', title: `always-${String(i).padStart(2, '0')}`,
      content: 'C'.repeat(200), properties: { applies: 'always', why: 'w', agreed: 'yes' },
    })
  }
  for (let i = 0; i < situational; i++) {
    eml.engrams.store({
      type: 'rule', scope: 'global', title: `situational-${String(i).padStart(2, '0')}`,
      content: 'D'.repeat(200), properties: { applies: 'situational', trigger: 'E'.repeat(80), why: 'w', agreed: 'yes' },
    })
  }
  return eml
}

// Legacy entries cannot be stored through the store any more; plant them with
// a raw UPDATE, the way they sit in an existing brain.
function plantLegacy(eml: EML, scope: string, title: string, content: string): void {
  const r = eml.engrams.store({ type: 'rule', scope, title, content: 'x', properties: { applies: 'always', why: 'w', agreed: 'yes' } })
  ;(eml as any).db.prepare('UPDATE engrams SET content = ? WHERE id = ?').run(content, r.id)
}

const systemSection = (md: string) => {
  const from = md.indexOf('## EML System Rules')
  const to = md.indexOf('\n---\n')
  return md.slice(from, to < 0 ? undefined : to).trimEnd()
}
const OVERFLOW_LINE = /\n---\n(\d+) entries listed by title only to fit the boot's size budget — eml_get <id> for the full text\.$/
const LEFT_OUT_LINE = /\n---\n(\d+) entries listed by title only and (\d+) left out to fit the boot's size budget — eml_get <id> for the full text, eml_list type=rule or type=profile for the ones left out\.(\n|$)/

const LEGACY_LEFT_OUT_LINE = /\n---\n(\d+) entries left out to fit the boot's size budget — eml_list type=rule or type=profile for the ones left out\.\n/

/** The largest budget at which entries are left out or `pred` holds (it must fail for large budgets). */
function largestBudget(eml: EML, pred: (b: NonNullable<ReturnType<typeof boot>['budget']>) => boolean): number {
  let lo = 0
  let hi = boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const b = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: mid }).budget!
    if (b.left_out > 0 || pred(b)) lo = mid
    else hi = mid - 1
  }
  return lo
}

describe('boot size budget (v0.15)', () => {
  it(`the rendered system-rules section stays within ${SYSTEM_RULES_BUDGET} chars`, () => {
    const eml = new EML({ dbPath: ':memory:', namespace: 'test' })
    try {
      const section = systemSection(boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown)
      expect(section.length).toBeGreaterThan(0)
      expect(section.length).toBeLessThanOrEqual(SYSTEM_RULES_BUDGET)
    } finally { eml.close() }
  })
})

describe('boot hard budget (opts.budget)', () => {
  const NOTHING = { situational_title_only: 0, always_title_only: 0, profiles_title_only: 0, left_out: 0 }

  it('renders a small brain exactly as without a budget, and reports nothing given up', () => {
    const eml = brainWith(3, 3)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      const capped = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      expect(capped.markdown).toBe(free.markdown)
      expect(free.budget).toBeUndefined()
      expect(capped.budget).toEqual({ limit: 10_000, chars: free.markdown.length, ...NOTHING, fits: true })
      expect(capped.markdown).not.toContain('---')
    } finally { eml.close() }
  })

  it('an oversized brain fits the budget: whole entries fall back to title + id, system rules untouched', () => {
    // 4 core profiles, 20 always-rules, 20 situational rules, 5 legacy rules of
    // 1,500 chars: ~14,400 chars unbounded.
    const eml = brainWith(20, 20, 3)
    for (let i = 0; i < 5; i++) plantLegacy(eml, 'global', `legacy-${i}`, 'L'.repeat(1_500))
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      expect(free.markdown.length).toBeGreaterThan(14_000)
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      expect(r.markdown.length).toBeLessThanOrEqual(10_000)
      expect(r.budget).toMatchObject({ limit: 10_000, chars: r.markdown.length, left_out: 0, fits: true })
      expect(systemSection(r.markdown)).toBe(systemSection(free.markdown))
      // nothing cut mid-text: every body is whole or absent
      expect(r.markdown).not.toMatch(/…/)
      expect(r.markdown).not.toMatch(/\]\*\* C{1,199}$/m)
      expect(r.markdown).not.toContain('L'.repeat(201))
      const n = r.budget!.situational_title_only + r.budget!.always_title_only + r.budget!.profiles_title_only
      expect(n).toBeGreaterThan(20)
      // the footer also counts user2's profile, over the identity block's cap
      expect(r.markdown).toMatch(/^- \[user\.user2 \| user2\] · [0-9a-f-]{36}$/m)
      expect(r.markdown).toContain(`\n---\n${n + 1} entries listed by title only to fit the boot's size budget — eml_get <id> for the full text.\n`)
      expect(r.markdown).toMatch(/\n5 entries are in the old long format and listed by title only — eml_get <id> for the full text \(always-rules among them stay binding\)\.$/)
    } finally { eml.close() }
  })

  it('stays within the budget for brains of any size', () => {
    for (const [always, situational, users] of [[0, 0, 1], [5, 5, 1], [20, 40, 2], [60, 60, 4], [150, 150, 8]]) {
      const eml = brainWith(always, situational, users)
      try {
        const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
        expect(r.markdown.length).toBeLessThanOrEqual(10_000)
        expect(r.budget?.fits).toBe(true)
      } finally { eml.close() }
    }
  })

  it('past title + id, leaves whole entries out in the same order and says so', () => {
    const eml = brainWith(100, 100)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
      const m = r.budget!.left_out
      expect(m).toBeGreaterThan(100)
      expect(r.budget).toMatchObject({ situational_title_only: 0, profiles_title_only: 0, always_title_only: 200 - m, fits: true })
      // situational rules all left out first, then always-rules (equal lengths: the last first)
      expect(r.markdown).not.toContain('## Rules (situational')
      expect(r.markdown).not.toContain('[global | always-99]')
      expect(r.markdown).toContain('[global | always-00]')
      expect(r.markdown).toContain(`- **[agent.assistant | assistant]** ${'A'.repeat(400)}`)
      expect(systemSection(r.markdown)).toBe(systemSection(free.markdown))
      const line = r.markdown.match(LEFT_OUT_LINE)
      expect(line?.[2]).toBe(String(m))
      expect(line?.[1]).toBe(String(200 - m))
    } finally { eml.close() }
  })

  it('situational rules go first, from the last; the rest is unchanged', () => {
    const eml = brainWith(8, 20)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      // one trigger saves less than the footer line costs: two have to give way
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: free.markdown.length - 1 })
      expect(r.budget).toMatchObject({ ...NOTHING, situational_title_only: 2, fits: true })
      const head = (md: string) => md.slice(0, md.indexOf('## Rules (situational'))
      expect(head(r.markdown)).toBe(head(free.markdown))
      expect(r.markdown).toMatch(/^- \[global \| situational-19\] · [0-9a-f-]{36}$/m)
      expect(r.markdown).toMatch(/^- \[global \| situational-18\] · [0-9a-f-]{36}$/m)
      expect(r.markdown).toMatch(/^- \*\*\[global \| situational-17\]\*\* when: E{80} · [0-9a-f-]{36}$/m)
      expect(r.markdown.match(OVERFLOW_LINE)?.[1]).toBe('2')
    } finally { eml.close() }
  })

  it('takes the fewest fallbacks that fit', () => {
    const eml = brainWith(2, 6)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES }).markdown.length
      const at = (budget: number) => boot(eml, 'assistant', { systemRules: ALL_RULES, budget }).budget!
      expect(at(free)).toMatchObject(NOTHING)
      const b = largestBudget(eml, r => r.situational_title_only >= 3)
      expect(at(b)).toMatchObject({ ...NOTHING, situational_title_only: 3 })
      expect(at(b + 1).situational_title_only).toBe(2)
    } finally { eml.close() }
  })

  it('then always-rules, longest first', () => {
    const eml = brainWith(0, 2)
    for (const [title, len] of [['r-short', 50], ['r-long', 200], ['r-mid', 120]] as const) {
      eml.engrams.store({ type: 'rule', scope: 'global', title, content: title + '.'.repeat(len - title.length), properties: { applies: 'always', why: 'w', agreed: 'yes' } })
    }
    try {
      const b = largestBudget(eml, r => r.always_title_only >= 1)
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: b })
      expect(r.budget).toMatchObject({ situational_title_only: 2, always_title_only: 1, profiles_title_only: 0, left_out: 0 })
      expect(r.markdown).toMatch(/^- \[global \| r-long\] · [0-9a-f-]{36}$/m)
      expect(r.markdown).toContain('r-mid.')
      expect(r.markdown).toContain('r-short.')
    } finally { eml.close() }
  })

  it('then profiles beyond the first two; the agent and the first user keep theirs', () => {
    const eml = brainWith(1, 1, 2)
    try {
      const b = largestBudget(eml, r => r.profiles_title_only >= 1)
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: b })
      expect(r.budget).toMatchObject({ situational_title_only: 1, always_title_only: 1, profiles_title_only: 1, left_out: 0 })
      expect(r.markdown).toContain(`- **[agent.assistant | assistant]** ${'A'.repeat(400)}`)
      expect(r.markdown).toContain(`- **[user.user0 | user0]** ${'B'.repeat(400)}`)
      expect(r.markdown).toMatch(/^- \[user\.user1 \| user1\] · [0-9a-f-]{36}$/m)
    } finally { eml.close() }
  })

  it('reports fits=false and keeps the system rules and first two profiles whole when nothing more can give way', () => {
    const eml = brainWith(8, 3, 2)
    try {
      const free = boot(eml, 'assistant', { systemRules: ALL_RULES })
      const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 1_000 })
      expect(r.budget).toMatchObject({ limit: 1_000, fits: false, left_out: 12 })
      expect(r.markdown.length).toBe(r.budget!.chars)
      expect(systemSection(r.markdown)).toBe(systemSection(free.markdown))
      expect(r.markdown).toContain('A'.repeat(400))
      expect(r.markdown).toContain(`- **[user.user0 | user0]** ${'B'.repeat(400)}`)
      expect(r.markdown).not.toContain('user1')
    } finally { eml.close() }
  })
})

describe('boot footer when only legacy entries give way', () => {
  it('names the entries left out without a "0 listed by title only"', () => {
    // An unmigrated brain: every rule in the old long format, already title + id.
    const eml = brainWith(0, 0)
    for (let i = 0; i < 200; i++) plantLegacy(eml, 'global', `legacy-${String(i).padStart(3, '0')}`, 'L'.repeat(800))
    const r = boot(eml, 'assistant', { systemRules: ALL_RULES, budget: 10_000 })
    expect(r.budget!.fits).toBe(true)
    expect(r.budget!.left_out).toBeGreaterThan(0)
    expect(r.markdown).not.toMatch(/\b0 entries listed by title only/)
    const m = r.markdown.match(LEGACY_LEFT_OUT_LINE)
    expect(m && Number(m[1])).toBe(r.budget!.left_out)
    eml.close()
  })
})
