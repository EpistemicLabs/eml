import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EML, boot, formatProblems } from '../src'
import {
  seedDefaultBrain,
  slugifyIdentityName,
  DEFAULT_BRAIN_AGENT_ID,
  DEFAULT_BRAIN_USER_ID,
} from '../src/default-brain'

describe('seedDefaultBrain', () => {
  let dir: string
  let brainPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'eml-default-brain-test-'))
    brainPath = join(dir, 'fresh.db')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('creates the brain file on disk', () => {
    expect(existsSync(brainPath)).toBe(false)
    seedDefaultBrain(brainPath)
    expect(existsSync(brainPath)).toBe(true)
  })

  describe('with default agentId/userId', () => {
    it('writes 5 engrams (2 profile + 3 rule)', () => {
      seedDefaultBrain(brainPath)
      const eml = new EML({ dbPath: brainPath, namespace: DEFAULT_BRAIN_AGENT_ID })
      try {
        const results = eml.engrams.query({})
        expect(results).toHaveLength(5)
        expect(results.filter(e => e.type === 'profile')).toHaveLength(2)
        expect(results.filter(e => e.type === 'rule')).toHaveLength(3)
      } finally {
        eml.close()
      }
    })

    it('creates agent + user records', () => {
      seedDefaultBrain(brainPath)
      const eml = new EML({ dbPath: brainPath, namespace: DEFAULT_BRAIN_AGENT_ID })
      try {
        expect(eml.agents.exists(DEFAULT_BRAIN_AGENT_ID)).toBe(true)
        expect(eml.users.exists(DEFAULT_BRAIN_USER_ID)).toBe(true)
      } finally {
        eml.close()
      }
    })

    it('marks every seed with origin eml-default-brain (v0.19: was properties.source_id)', () => {
      seedDefaultBrain(brainPath)
      const eml = new EML({ dbPath: brainPath, namespace: DEFAULT_BRAIN_AGENT_ID })
      try {
        for (const engram of eml.engrams.query({})) {
          const props = engram.properties as Record<string, unknown>
          expect(engram.origin).toBe('eml-default-brain')
          expect(engram.ingestion_method).toBe('direct')
          expect(engram.significance).toBe('normal')
          expect(props.source_id).toBeUndefined()
          expect(props.source_type).toBeUndefined()
        }
      } finally {
        eml.close()
      }
    })

    it('the identity profiles are the core profiles; the rules carry why and agreed', () => {
      seedDefaultBrain(brainPath)
      const eml = new EML({ dbPath: brainPath, namespace: DEFAULT_BRAIN_AGENT_ID })
      try {
        const profiles = eml.engrams.query({ type: 'profile' })
        expect(profiles).toHaveLength(2)
        for (const p of profiles) expect((p.properties as Record<string, unknown>).core).toBe(true)
        for (const r of eml.engrams.query({ type: 'rule' })) {
          const props = r.properties as Record<string, unknown>
          expect(typeof props.why).toBe('string')
          expect(typeof props.agreed).toBe('string')
          expect(props.boot).toBeUndefined()
        }
      } finally {
        eml.close()
      }
    })
  })

  describe('with custom agentId/userId', () => {
    it('substitutes <agent> + <user> in title and scope', () => {
      seedDefaultBrain(brainPath, 'assistant', 'alice')
      const eml = new EML({ dbPath: brainPath, namespace: 'assistant' })
      try {
        const engrams = eml.engrams.query({})
        const subjects = engrams.map(e => e.title)
        expect(subjects).toContain('assistant-identity')
        expect(subjects).toContain('alice-identity')
        expect(subjects).toContain('assistant-reasoning-discipline')
        expect(subjects).toContain('assistant-engagement-style')
        expect(subjects).toContain('assistant-action-protocol')

        expect(engrams.find(e => e.title === 'assistant-identity')?.scope).toBe('agent.assistant')
        expect(engrams.find(e => e.title === 'alice-identity')?.scope).toBe('user.alice')
        expect(engrams.find(e => e.title === 'assistant-action-protocol')?.scope).toBe('agent.assistant')
      } finally {
        eml.close()
      }
    })

    it('substitutes <agent> + <user> in engram content', () => {
      seedDefaultBrain(brainPath, 'assistant', 'alice')
      const eml = new EML({ dbPath: brainPath, namespace: 'assistant' })
      try {
        const engrams = eml.engrams.query({})
        for (const e of engrams) {
          expect(e.content).not.toMatch(/<agent>/)
          expect(e.content).not.toMatch(/<user>/)
        }
        const agentIdentity = engrams.find(e => e.title === 'assistant-identity')
        expect(agentIdentity?.content).toContain('I am assistant')
        expect(agentIdentity?.content).toContain('for alice')
      } finally {
        eml.close()
      }
    })

    it('seeds the short format without a boot flag, and the boot carries every template whole', () => {
      seedDefaultBrain(brainPath, 'assistant', 'alice')
      const eml = new EML({ dbPath: brainPath, namespace: 'assistant' })
      try {
        const engrams = eml.engrams.query({})
        for (const e of engrams) {
          expect((e.properties as Record<string, unknown>).boot).toBeUndefined()
          expect(formatProblems(e.type, e.content, e.properties as Record<string, unknown>)).toEqual([])
        }
        const r = boot(eml, 'assistant')
        expect(r.engrams).toBe(5)
        expect(r.legacy).toBe(0)
        for (const e of engrams) expect(r.markdown).toContain(e.content)
      } finally {
        eml.close()
      }
    })

    it('creates agent + user records with given ids', () => {
      seedDefaultBrain(brainPath, 'assistant', 'alice')
      const eml = new EML({ dbPath: brainPath, namespace: 'assistant' })
      try {
        expect(eml.agents.exists('assistant')).toBe(true)
        expect(eml.users.exists('alice')).toBe(true)
      } finally {
        eml.close()
      }
    })
  })

  describe('with display names', () => {
    it('uses the names in prose and agent/user records, the ids everywhere else', () => {
      seedDefaultBrain(brainPath, 'juno', 'alex-doe', { agentName: 'Juno', userName: 'Alex Doe' })
      const eml = new EML({ dbPath: brainPath, namespace: 'juno' })
      try {
        const engrams = eml.engrams.query({})
        const agentIdentity = engrams.find(e => e.title === 'juno-identity')
        const userIdentity = engrams.find(e => e.title === 'alex-doe-identity')
        expect(agentIdentity?.scope).toBe('agent.juno')
        expect(agentIdentity?.content).toContain('I am Juno,')
        expect(agentIdentity?.content).toContain('for Alex Doe —')
        expect(agentIdentity?.content).toContain('makes me Juno across')
        expect(userIdentity?.scope).toBe('user.alex-doe')
        expect(userIdentity?.content).toMatch(/^Alex Doe — the human/)
        expect(eml.agents.get('juno')?.name).toBe('Juno')
        expect(eml.users.get('alex-doe')?.name).toBe('Alex Doe')
      } finally {
        eml.close()
      }
    })
  })
})

describe('slugifyIdentityName', () => {
  it('folds accents and separators into a lowercase kebab slug', () => {
    expect(slugifyIdentityName('Alex Doe')).toBe('alex-doe')
    expect(slugifyIdentityName('  Jürgen Groß ')).toBe('jurgen-gross')
    expect(slugifyIdentityName('Zoë-Marie_O\'Brien')).toBe('zoe-marie-o-brien')
    expect(slugifyIdentityName('R2-D2')).toBe('r2-d2')
  })

  it('returns an empty string when nothing usable is left', () => {
    expect(slugifyIdentityName('')).toBe('')
    expect(slugifyIdentityName('!!!')).toBe('')
    expect(slugifyIdentityName('李雷')).toBe('')
  })

  it('caps the slug at 40 characters without a trailing dash', () => {
    const slug = slugifyIdentityName('a'.repeat(39) + ' bcd')
    expect(slug.length).toBeLessThanOrEqual(40)
    expect(slug.endsWith('-')).toBe(false)
  })
})
