import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ProjectRegistry, projectIdForBrain } from '../src/project-registry.js'
import { brainProjectOf, moveProject, planProjectMove, rehome, type MoveSpace } from '../src/project-move.js'

// v0.21 (spec team-brain-move-project-spec §5, host): the plan and the move go
// to the brain server on the source's token and come back as they are; on a
// move that went through, the project's local state follows it into the
// target space's registry.

interface Seen { method: string; url: string; auth: string | undefined; body: Record<string, unknown> }

let server: Server | null = null
let dir: string

/** A stand-in brain server: /move/plan answers a plan, /move answers what `move` says. */
async function fakeBrain(move: { status: number; body: Record<string, unknown> }): Promise<{ url: string; seen: Seen[] }> {
  const seen: Seen[] = []
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body: body ? JSON.parse(body) as Record<string, unknown> : {} })
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/move/plan') {
        res.end(JSON.stringify({ project: 'top', tree: [{ id: 'top', engrams: 2 }], plan_hash: 'a'.repeat(64), collisions: [] }))
      } else if (req.url === '/move') {
        res.statusCode = move.status
        res.end(JSON.stringify(move.body))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

const invalidated: string[] = []
function space(id: string, url: string, registry: ProjectRegistry): MoveSpace {
  return { id, name: `Space ${id}`, url, token: `tok-${id}`, registry, projects: { invalidate: () => { invalidated.push(id) } } }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eml-project-move-'))
  invalidated.length = 0
})
afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve))
  server = null
  rmSync(dir, { recursive: true, force: true })
})

describe('brainProjectOf', () => {
  it('takes the sidebar\'s bp- id or the brain id itself', () => {
    expect(brainProjectOf(projectIdForBrain('top'))).toBe('top')
    expect(brainProjectOf('top')).toBe('top')
  })
})

describe('planProjectMove', () => {
  it('asks the source brain on its token, naming the target space, and passes the plan through', async () => {
    const brain = await fakeBrain({ status: 200, body: {} })
    const source = space('src', brain.url, new ProjectRegistry(join(dir, 'src.json'), join(dir, 'src-folders')))
    const target = space('tgt', brain.url, new ProjectRegistry(join(dir, 'tgt.json'), join(dir, 'tgt-folders')))
    const answer = await planProjectMove(source, target, 'top')
    expect(answer).toMatchObject({ status: 200, body: { project: 'top', plan_hash: 'a'.repeat(64), collisions: [] } })
    expect(brain.seen).toEqual([expect.objectContaining({ method: 'POST', url: '/move/plan', auth: 'Bearer tok-src', body: { target: 'tgt', project: 'top' } })])
    expect(invalidated).toEqual([])
  })
})

describe('moveProject', () => {
  it('runs the move and carries the projects\' local state into the target space', async () => {
    const brain = await fakeBrain({ status: 200, body: { project: 'top', archived: ['top', 'child'], moved: { engrams: 2 } } })
    const srcRegistry = new ProjectRegistry(join(dir, 'src.json'), join(dir, 'src-folders'))
    const tgtRegistry = new ProjectRegistry(join(dir, 'tgt.json'), join(dir, 'tgt-folders'))
    const folder = join(dir, 'top-folder')
    mkdirSync(folder)
    srcRegistry.ensureBrain('top', 'Top')
    srcRegistry.update(projectIdForBrain('top'), { displayName: 'My Top', starred: true, path: folder })
    srcRegistry.ensureBrain('child', 'Child')
    srcRegistry.update(projectIdForBrain('child'), { hidden: true })
    srcRegistry.ensureBrain('stays', 'Stays')
    const storedFolder = srcRegistry.get(projectIdForBrain('top'))!.path

    const answer = await moveProject(space('src', brain.url, srcRegistry), space('tgt', brain.url, tgtRegistry), 'top', 'a'.repeat(64))
    expect(answer).toMatchObject({ status: 200, body: { project: 'top', archived: ['top', 'child'], rehomed: ['top', 'child'] } })
    expect(brain.seen).toEqual([expect.objectContaining({ url: '/move', auth: 'Bearer tok-src', body: { target: 'tgt', target_name: 'Space tgt', project: 'top', plan_hash: 'a'.repeat(64) } })])
    expect(invalidated).toEqual(['src', 'tgt'])
    // in the target as it was: name, pin, folder, hidden
    expect(tgtRegistry.get(projectIdForBrain('top'))).toMatchObject({ kind: 'brain', brainProjectId: 'top', displayName: 'My Top', customName: 'My Top', starred: true, path: storedFolder })
    expect(tgtRegistry.get(projectIdForBrain('child'))).toMatchObject({ displayName: 'Child', customName: null, hidden: true, path: null })
    // gone from the source; what did not move stays
    expect(srcRegistry.get(projectIdForBrain('top'))).toBeUndefined()
    expect(srcRegistry.get(projectIdForBrain('child'))).toBeUndefined()
    expect(srcRegistry.get(projectIdForBrain('stays'))).toMatchObject({ displayName: 'Stays' })
  })

  it('a refused move passes through and changes no local state', async () => {
    const brain = await fakeBrain({ status: 409, body: { error: 'move refused: the plan changed since it was made. Nothing was moved.', code: 'PLAN_CHANGED', plan_hash: 'b'.repeat(64) } })
    const srcRegistry = new ProjectRegistry(join(dir, 'src.json'), join(dir, 'src-folders'))
    const tgtRegistry = new ProjectRegistry(join(dir, 'tgt.json'), join(dir, 'tgt-folders'))
    srcRegistry.ensureBrain('top', 'Top')
    const answer = await moveProject(space('src', brain.url, srcRegistry), space('tgt', brain.url, tgtRegistry), 'top', 'a'.repeat(64))
    expect(answer).toEqual({ status: 409, body: { error: 'move refused: the plan changed since it was made. Nothing was moved.', code: 'PLAN_CHANGED', plan_hash: 'b'.repeat(64) } })
    expect(srcRegistry.get(projectIdForBrain('top'))).toBeDefined()
    expect(tgtRegistry.list()).toEqual([])
    expect(invalidated).toEqual(['src'])
  })

  it('a brain that cannot be reached is 502, nothing changed', async () => {
    const srcRegistry = new ProjectRegistry(join(dir, 'src.json'), join(dir, 'src-folders'))
    const answer = await moveProject(space('src', 'http://127.0.0.1:1', srcRegistry), space('tgt', 'http://127.0.0.1:1', new ProjectRegistry(join(dir, 'tgt.json'), join(dir, 'tgt-folders'))), 'top', 'a'.repeat(64))
    expect(answer).toMatchObject({ status: 502, body: { code: 'BRAIN_UNAVAILABLE' } })
  })
})

describe('rehome', () => {
  it('a project without a local entry, and a folder that is gone: the entry is carried without it', () => {
    const src = new ProjectRegistry(join(dir, 'src.json'), join(dir, 'src-folders'))
    const tgt = new ProjectRegistry(join(dir, 'tgt.json'), join(dir, 'tgt-folders'))
    const folder = join(dir, 'gone')
    mkdirSync(folder)
    src.ensureBrain('top', 'Top')
    src.update(projectIdForBrain('top'), { path: folder, starred: true })
    rmSync(folder, { recursive: true })
    expect(rehome(src, tgt, ['top', 'never-registered'])).toEqual(['top'])
    expect(tgt.get(projectIdForBrain('top'))).toMatchObject({ starred: true, path: null })
    expect(tgt.get(projectIdForBrain('never-registered'))).toBeUndefined()
  })
})

describe('who can call the move routes', () => {
  // The host's write routes are behind the Origin gate (http.ts createHostServer):
  // a write without the cockpit page's Origin is 403, except the three routes a
  // session reaches with its per-boot token. The move is not one of them.
  it('the move is not a token endpoint: a write without the page Origin is refused', async () => {
    const { isTokenEndpoint } = await import('../src/http.js')
    expect(isTokenEndpoint('/api/projects/bp-top/move')).toBe(false)
    expect(isTokenEndpoint('/api/projects/bp-top/move-plan?target=x')).toBe(false)
    expect(isTokenEndpoint('/api/spawn')).toBe(true)
    expect(isTokenEndpoint('/api/hook')).toBe(true)
    expect(isTokenEndpoint('/api/sessions/eml-abc1/message')).toBe(true)
    expect(isTokenEndpoint('/api/sessions/eml-abc1/archive')).toBe(false)
    expect(isTokenEndpoint('/api/session-title/0f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true)
  })
})
