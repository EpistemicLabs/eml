import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The agents API (agents-api.ts): the home's agents with the spaces they
// work in, a GET-only read of an agent's brain with the token staying in the
// host, the handle the upgrade waits for (taken once), the report folder.

const home = mkdtempSync(join(tmpdir(), 'cockpit-agents-api-test-'))
process.env.EML_COCKPIT_HOME = home

let brain: http.Server
let host: http.Server
let base: string
const seen: Array<{ method: string; url: string; auth?: string }> = []
const revealed: string[] = []

const listen = (server: http.Server) =>
  new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))

beforeAll(async () => {
  const { handleAgentsApi } = await import('../src/agents-api.js')
  const { AgentBrains } = await import('../src/agents.js')
  // The agent's display name comes from its brain's agents table (readBrainInfo); a stand-in here.
  const info = () => ({ agents: [{ id: 'juno', name: 'Juno' }], users: [{ id: 'alex', name: 'Alex' }] })
  const reveal = async (file: string) => { revealed.push(file) }
  writeFileSync(join(home, 'config'), JSON.stringify({ token: 't', spaces: [{ token: 'u', name: 'Life', agent: 'juno' }], agents: [{ id: 'juno', token: 'j' }] }))

  brain = http.createServer((req, res) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ count: 1, engrams: [{ id: 'p1', type: 'profile', scope: 'agent.juno' }] }))
  })
  const brainUrl = `http://127.0.0.1:${await listen(brain)}`
  const agents = new AgentBrains([{ id: 'juno', brainId: 'brain-juno', url: brainUrl, token: 'brain-token-juno' }])
  const main = { id: 'brain-main', name: 'Main', main: true, agent: 'juno', upgrade: null }
  const life = { id: 'brain-life', name: 'Life', main: false, agent: null, upgrade: { reason: 'the brain needs intervention first (status needs_intervention)', report: '/tmp/reports/x' } }
  const spaces = {
    list: () => [main, life],
    fromHeader: (h: string | string[] | undefined) => (h === 'brain-life' ? life : h === undefined || h === '' ? main : null),
  }
  host = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const json = (r: http.ServerResponse, status: number, payload: unknown) => { r.writeHead(status, { 'Content-Type': 'application/json' }); r.end(JSON.stringify(payload)) }
    const readJson = async (r: http.IncomingMessage) => {
      let raw = ''
      for await (const c of r) raw += c
      return raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    }
    void handleAgentsApi(req, res, { agents, spaces, info, reveal } as never, url.pathname, req.method ?? 'GET', json, readJson)
      .then((handled) => { if (!handled) json(res, 404, { error: 'no route' }) })
  })
  base = `http://127.0.0.1:${await listen(host)}`
})

afterAll(async () => {
  await new Promise((r) => host.close(r))
  await new Promise((r) => brain.close(r))
  rmSync(home, { recursive: true, force: true })
})

describe('agents API', () => {
  it('lists the agents with their names and the spaces they work in', async () => {
    const res = await fetch(`${base}/api/agents`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ handle: null, agents: [{ id: 'juno', name: 'Juno', brainId: 'brain-juno', runtime: false, spaces: [{ id: 'brain-main', name: 'Main' }] }] })
  })

  it('reads an agent brain on the host\'s token, GET only, and knows no other agent', async () => {
    seen.length = 0
    const res = await fetch(`${base}/api/agents/juno/brain/list?type=profile&scope=agent.juno`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ count: 1 })
    expect(seen).toEqual([{ method: 'GET', url: '/list?type=profile&scope=agent.juno', auth: 'Bearer brain-token-juno' }])
    expect((await fetch(`${base}/api/agents/juno/brain/engram/x`, { method: 'POST', body: '{}' })).status).toBe(405)
    expect((await fetch(`${base}/api/agents/scout/brain/list`)).status).toBe(404)
    expect(seen).toHaveLength(1)
  })

  it('takes the handle once, checked, and says the upgrade runs at the next start', async () => {
    const post = (body: unknown) => fetch(`${base}/api/agent-upgrade/handle`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    expect((await post({ handle: 'Not A Handle' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    const ok = await post({ handle: ' alex ' })
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ handle: 'alex', restart: true })
    const { readCockpitConfig } = await import('../src/config.js')
    expect((await readCockpitConfig())?.handle).toBe('alex')
    const again = await post({ handle: 'bob' })
    expect(again.status).toBe(409)
    expect((await readCockpitConfig())?.handle).toBe('alex')
  })

  it('reveals the active space\'s report folder, and has none for a bound space', async () => {
    expect((await fetch(`${base}/api/agent-upgrade/reveal`, { method: 'POST', headers: { 'x-cockpit-space': 'brain-life' } })).status).toBe(200)
    expect(revealed).toEqual(['/tmp/reports/x'])
    expect((await fetch(`${base}/api/agent-upgrade/reveal`, { method: 'POST' })).status).toBe(404)
  })
})
