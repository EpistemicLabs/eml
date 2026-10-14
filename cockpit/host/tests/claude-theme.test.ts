import { describe, it, expect } from 'vitest'
import { seededClaudeTheme } from '../src/infrastructure/providers/claude/isolation.js'

describe('seededClaudeTheme', () => {
  it('seeds auto when Claude Code has no theme yet', () => {
    expect(seededClaudeTheme(undefined, false)).toBe('auto')
    expect(seededClaudeTheme('', true)).toBe('auto')
  })

  it('switches the dark value older cockpits seeded to auto, once', () => {
    expect(seededClaudeTheme('dark', false)).toBe('auto')
    expect(seededClaudeTheme('dark', true)).toBe('dark')
  })

  it("keeps the user's own choice", () => {
    expect(seededClaudeTheme('light', false)).toBe('light')
    expect(seededClaudeTheme('dark-daltonized', false)).toBe('dark-daltonized')
    expect(seededClaudeTheme('auto', true)).toBe('auto')
  })
})
