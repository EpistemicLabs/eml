import { describe, it, expect } from 'vitest'
import { createServer } from 'node:net'
import { validateIdentity, runFirstRunSetup } from '../src/setup.js'
import type { BrainIdentity, ProvisionedBrain } from '../src/provision.js'

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port
      s.close(() => resolve(port))
    })
  })
}

describe('validateIdentity', () => {
  it('derives both slugs and keeps the names as given (trimmed)', () => {
    expect(validateIdentity({ userName: ' Alex Doe ', agentName: 'Juno' }, slugify)).toEqual({
      userId: 'alex-doe', userName: 'Alex Doe', agentId: 'juno', agentName: 'Juno',
    })
  })

  it('rejects missing, too long, unusable and colliding names', () => {
    expect(validateIdentity({ userName: 'Alex' }, slugify)).toMatchObject({ code: 'NAME_REQUIRED' })
    expect(validateIdentity({ userName: 'a'.repeat(61), agentName: 'Juno' }, slugify)).toMatchObject({ code: 'NAME_TOO_LONG' })
    expect(validateIdentity({ userName: '!!!', agentName: 'Juno' }, slugify)).toMatchObject({ code: 'NAME_UNUSABLE' })
    expect(validateIdentity({ userName: 'Juno', agentName: 'juno' }, slugify)).toMatchObject({ code: 'NAMES_COLLIDE' })
  })
})

describe('runFirstRunSetup', () => {
  it('serves the setup, refuses other API calls and cross-origin writes, provisions once, then frees the port', async () => {
    const port = await freePort()
    const origin = `http://127.0.0.1:${port}`
    const provisioned: BrainIdentity[] = []
    const provision = async (identity: BrainIdentity): Promise<ProvisionedBrain> => {
      provisioned.push(identity)
      return { token: 'tok', reused: false, onboarding: 'pending' }
    }
    let listening!: () => void
    const ready = new Promise<void>((r) => { listening = r })
    const done = runFirstRunSetup({ port, allowedOrigins: [origin], provision, slugify, onListening: () => listening() })
    await ready

    expect(await (await fetch(`${origin}/api/setup`)).json()).toEqual({ needed: true })
    expect((await fetch(`${origin}/api/projects`)).status).toBe(503)

    const post = (body: unknown, from = origin) => fetch(`${origin}/api/setup`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: from }, body: JSON.stringify(body),
    })
    expect((await post({ userName: 'Alex', agentName: 'Juno' }, 'http://evil.example')).status).toBe(403)
    const invalid = await post({ userName: 'Juno', agentName: 'Juno' })
    expect(invalid.status).toBe(400)
    expect((await invalid.json()).error.code).toBe('NAMES_COLLIDE')

    const ok = await post({ userName: 'Alex', agentName: 'Juno' })
    expect(await ok.json()).toEqual({ ok: true, userId: 'alex', agentId: 'juno' })
    await expect(done).resolves.toMatchObject({ token: 'tok', onboarding: 'pending' })
    expect(provisioned).toHaveLength(1)

    // The port is free again for the real host.
    await new Promise<void>((resolve, reject) => {
      const s = createServer()
      s.once('error', reject)
      s.listen(port, '127.0.0.1', () => s.close(() => resolve()))
    })
  })
})
