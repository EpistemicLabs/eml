import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The host's brain proxy (http.ts proxyBrain) passes only the routes the
// cockpit page uses (page-brain-routes.ts). Everything else — deleting a
// brain, a team's routes, a project's move — is refused before the brain
// server sees it, whatever Origin the caller sends: those go through the
// host's own routes with their backup, typed name and fingerprint.

const home = mkdtempSync(join(tmpdir(), 'cockpit-page-routes-test-'))
process.env.EML_COCKPIT_HOME = home

const ORIGIN = 'http://cockpit.test'
const seen: Array<{ method: string; url: string }> = []
let brain: http.Server
let host: http.Server
let base: string

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

beforeAll(async () => {
  brain = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '' })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('{}')
  })
  const url = `http://127.0.0.1:${await listen(brain)}`
  const main = { id: 'brain-main', name: 'Main', main: true, url, token: 'space-token', projects: { invalidate: () => {} } }
  const { createHostServer } = await import('../src/http.js')
  const deps = { spaces: { fromHeader: (h: unknown) => (h === undefined ? main : null) } }
  host = createHostServer(deps as never, [ORIGIN])
  base = `http://127.0.0.1:${await listen(host)}`
})

afterAll(async () => {
  await new Promise((r) => host.close(r))
  await new Promise((r) => brain.close(r))
  rmSync(home, { recursive: true, force: true })
})

/** A raw request, so `..` and encoded segments reach the host as sent (fetch would resolve them). */
function send(method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers: { Origin: ORIGIN, 'Content-Type': 'application/json' } }, (res) => {
      let text = ''
      res.on('data', (c) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text }))
    })
    req.on('error', reject)
    req.end(body)
  })
}

describe('host brain proxy: the page\'s routes only', () => {
  it('passes every route the page uses, with the query on a read', async () => {
    const passed: Array<[string, string]> = [
      ['GET', '/list?type=task&limit=5'], ['GET', '/projects?status=active'], ['GET', '/stats'], ['GET', '/subjects'],
      ['GET', '/engram/0b5c6c1e-1111-4222-8333-944455556666?with_relations=true'],
      ['GET', '/project/eml'], ['GET', '/project/eml-app/engrams?type=task'], ['GET', '/project/eml/relations'],
      ['POST', '/engram/task'], ['POST', '/recall'], ['POST', '/relate'], ['POST', '/update'],
      ['POST', '/engram/abc-123/confirm-review'], ['POST', '/task/abc_123/track'], ['POST', '/object/project'],
    ]
    for (const [method, path] of passed) {
      seen.length = 0
      const res = await send(method, `/api/brain${path}`, method === 'POST' ? '{}' : undefined)
      expect(res.status, `${method} ${path}`).toBe(200)
      expect(seen).toEqual([{ method, url: path }])
    }
  })

  it('refuses the routes that act on the brain itself, and every other one, without calling the server', async () => {
    const refused: Array<[string, string]> = [
      ['DELETE', '/brain'], ['DELETE', '/team'], ['GET', '/team'],
      ['POST', '/team/create'], ['POST', '/team/join'], ['POST', '/team/invites'],
      ['POST', '/team/invites/AAAAAAAAAAAAAAAAAAAAAA/accept'],
      ['POST', '/move/plan'], ['POST', '/move'],
      ['POST', '/retag'], ['POST', '/rescope'], ['POST', '/engram/note'], ['POST', '/object/user'], ['PUT', '/object/project/eml'],
      ['GET', '/hygiene'], ['HEAD', '/stats'], ['DELETE', '/list'], ['POST', '/list'],
      ['POST', '/update?x=1'],
      // a path that would resolve to another route upstream
      ['GET', '/engram/../team'], ['GET', '/engram/%2e%2e/team'], ['GET', '/engram/..%2Fteam'], ['GET', '/project/eml/../../team'],
      ['GET', ''], ['GET', '/'],
    ]
    seen.length = 0
    for (const [method, path] of refused) {
      const res = await send(method, `/api/brain${path}`, method === 'POST' || method === 'PUT' ? '{}' : undefined)
      expect(res.status, `${method} ${path}`).toBe(403)
      if (method !== 'HEAD') expect(JSON.parse(res.body).error.code).toBe('NOT_PASSED')
    }
    expect(seen).toEqual([])
  })

  it('names every brain route the page calls (the table and the frontend move together)', async () => {
    const { isPageRoute, SPACE_BRAIN_ROUTES } = await import('../src/page-brain-routes.js')
    const root = fileURLToPath(new URL('../../frontend/src', import.meta.url))
    const files: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(p)
      }
    }
    walk(root)
    const calls: Array<[string, string]> = []
    for (const file of files) {
      for (const m of readFileSync(file, 'utf8').matchAll(/brain(Get|Post)(?:<.*?>)?\(\s*(["'`])(\/[^"'`]*)\2/g)) {
        // a template's ${…} stands for an id
        calls.push([m[1] === 'Get' ? 'GET' : 'POST', m[3].replace(/\$\{[^}]+\}/g, 'some-id')])
      }
    }
    expect(calls.length).toBeGreaterThanOrEqual(17)
    for (const [method, path] of calls) expect(isPageRoute(SPACE_BRAIN_ROUTES, method, path), `${method} ${path}`).toBe(true)
  })
})
