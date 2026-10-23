import { describe, it, expect } from 'vitest'
import { sessionAddress } from '../src/session-address.js'

describe('session address', () => {
  const id = '7c6cc980-e41c-43f1-91d7-452f683d0349'

  it('is the brain project and the start of the session id — stable for the session', () => {
    expect(sessionAddress(id, 'bp-eml-app')).toBe('eml-app-7c6cc980')
    expect(sessionAddress(id, 'bp-eml-app')).toBe(sessionAddress(id, 'bp-eml-app'))
  })

  it('falls back to "session" for a folder project or none, and keeps only safe characters', () => {
    expect(sessionAddress(id, 'folder-1')).toBe('session-7c6cc980')
    expect(sessionAddress(id, null)).toBe('session-7c6cc980')
    expect(sessionAddress(id, 'bp-My Project/Ä')).toBe('my-project-7c6cc980')
  })
})
