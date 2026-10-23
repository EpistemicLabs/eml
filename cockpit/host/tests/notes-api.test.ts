import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-notes-test-'))
process.env.EML_COCKPIT_HOME = home

type Mods = typeof import('../src/notes-api.js') & typeof import('../src/project-registry.js')

// v0.20: a note save is a compare-and-swap on the engram's rev — the pane sends
// the rev it opened (baseRev), the brain checks base_rev in the write itself,
// and a 409 comes back as today's conflict response with the current note.
describe('notes api: save on rev', () => {
  let mods: Mods
  let note: { id: string, type: string, scope: string, status: string, origin: string, content: string, created_at: string, updated_at: string, rev: number, properties: Record<string, unknown> }
  const sent: Array<Record<string, unknown>> = []

  beforeAll(async () => {
    mods = { ...await import('../src/notes-api.js'), ...await import('../src/project-registry.js') }
    note = {
      id: 'n1', type: 'note', scope: 'project.p', status: 'active', origin: mods.NOTES_ORIGIN,
      content: 'v1', created_at: '2026-10-23T08:00:00.000Z', updated_at: '2026-10-23T08:00:00.000Z', rev: 1, properties: {},
    }
    // the brain: GET /engram/n1 and POST /update with its base_rev check
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string, body?: string }) => {
      const path = new URL(url).pathname
      const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
      if (path === '/engram/n1') return reply(200, note)
      if (path === '/update' && init?.method === 'POST') {
        const body = JSON.parse(init.body!)
        sent.push(body)
        if (body.base_rev !== undefined && body.base_rev !== note.rev) return reply(409, { error: 'changed', current_rev: note.rev })
        note = { ...note, content: body.patch.content, rev: note.rev + 1, properties: { app: body.patch.app } }
        return reply(200, note)
      }
      return reply(404, { error: 'Not found' })
    })
  })
  afterAll(() => { vi.unstubAllGlobals(); rmSync(home, { recursive: true, force: true }) })

  async function put(body: Record<string, unknown>): Promise<{ status: number, payload: any }> {
    let status = 0
    let payload: any = null
    const json = (_res: unknown, s: number, p: unknown) => { status = s; payload = p }
    const url = new URL('http://localhost/api/notes/n1')
    const watcher = { poke: () => {} } as never
    await mods.handleNotesApi({} as never, {} as never, { loopbackUrl: 'http://brain', brainToken: 't' }, url, 'PUT', json, async () => body, watcher)
    return { status, payload }
  }

  it('the view carries rev; a save on the current rev writes and passes base_rev', async () => {
    const r = await put({ content: 'v2', baseRev: 1 })
    expect(r.status).toBe(200)
    expect(r.payload.note).toMatchObject({ id: 'n1', projectId: mods.projectIdForBrain('p'), content: 'v2', rev: 2 })
    expect(sent.at(-1)).toMatchObject({ id: 'n1', base_rev: 1, patch: { content: 'v2' } })
  })

  it('a save on an old rev is the conflict response with the current note; nothing written', async () => {
    const r = await put({ content: 'mine', baseRev: 1 })
    expect(r.status).toBe(409)
    expect(r.payload).toMatchObject({ error: { code: 'CONFLICT' }, note: { content: 'v2', rev: 2 } })
    expect(note.content).toBe('v2')
  })

  it('without baseRev the save overwrites ("keep mine")', async () => {
    const r = await put({ content: 'mine' })
    expect(r.status).toBe(200)
    expect(sent.at(-1)!.base_rev).toBeUndefined()
    expect(r.payload.note).toMatchObject({ content: 'mine', rev: 3 })
  })
})
