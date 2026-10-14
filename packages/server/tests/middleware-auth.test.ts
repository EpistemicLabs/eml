import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { initControlDatabase, issueToken, revokeToken } from '@engramprotocol/core'
import { authenticate } from '../src/middleware/auth'

describe('authenticate', () => {
  let control: Database.Database
  let plaintext: string

  beforeEach(() => {
    control = initControlDatabase(':memory:')
    control.prepare('INSERT INTO users (id, email) VALUES (?, ?)').run('u1', 'a@b.de')
    control.prepare('INSERT INTO brains (id, name, owner_id, brain_file) VALUES (?, ?, ?, ?)')
      .run('b1', 'x', 'u1', 'brains/b1.db')
    plaintext = issueToken(control, { userId: 'u1', brainId: 'b1' }).plaintext
  })

  afterEach(() => {
    control.close()
  })

  it('valid Bearer token → ok ctx', () => {
    const result = authenticate(control, `Bearer ${plaintext}`)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.ctx.userId).toBe('u1')
      expect(result.ctx.brainId).toBe('b1')
      expect(result.ctx.tokenId).toBeTruthy()
    }
  })

  it('updates last_used_at on success', () => {
    const before = control.prepare(
      "SELECT last_used_at FROM tokens WHERE user_id = 'u1'"
    ).get() as { last_used_at: string | null }
    expect(before.last_used_at).toBeNull()

    authenticate(control, `Bearer ${plaintext}`)

    const after = control.prepare(
      "SELECT last_used_at FROM tokens WHERE user_id = 'u1'"
    ).get() as { last_used_at: string | null }
    expect(after.last_used_at).not.toBeNull()
  })

  it('missing header → 401 missing', () => {
    expect(authenticate(control, undefined)).toEqual({
      ok: false, status: 401, error: expect.stringContaining('missing'),
    })
    expect(authenticate(control, null)).toEqual({
      ok: false, status: 401, error: expect.stringContaining('missing'),
    })
    expect(authenticate(control, '')).toEqual({
      ok: false, status: 401, error: expect.stringContaining('missing'),
    })
  })

  it('non-Bearer scheme → 401 malformed', () => {
    expect(authenticate(control, 'Basic xyz')).toMatchObject({ ok: false, status: 401 })
    expect(authenticate(control, 'eml_xyz')).toMatchObject({ ok: false, status: 401 })
  })

  it('Bearer + unknown token → 401 invalid', () => {
    const fake = 'eml_' + 'f'.repeat(40)
    const result = authenticate(control, `Bearer ${fake}`)
    expect(result).toMatchObject({ ok: false, status: 401, error: expect.stringContaining('invalid') })
  })

  it('Bearer + revoked token → 401 invalid', () => {
    const tokenId = (control.prepare(
      "SELECT id FROM tokens WHERE user_id = 'u1'"
    ).get() as { id: string }).id
    revokeToken(control, tokenId)

    const result = authenticate(control, `Bearer ${plaintext}`)
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  it('handles whitespace-padded headers', () => {
    const result = authenticate(control, `   Bearer  ${plaintext}   `)
    expect(result.ok).toBe(true)
  })
})
