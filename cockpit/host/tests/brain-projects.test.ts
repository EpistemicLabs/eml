import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { BrainProjectsClient, BrainRenameError } from '../src/brain-projects.js'

interface Seen { method: string; url: string; auth: string | undefined; body: string }

let server: Server | null = null

/** A stand-in brain: one project, PUT /object/project/:id renames it, anything else 404s. */
async function fakeBrain(): Promise<{ url: string; seen: Seen[]; project: { id: string; name: string } }> {
  const seen: Seen[] = []
  const project = { id: 'alpha', name: 'Alpha' }
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', auth: req.headers.authorization, body })
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET' && req.url === '/projects') {
        res.end(JSON.stringify({ projects: [project] }))
      } else if (req.method === 'PUT' && req.url === `/object/project/${project.id}`) {
        project.name = (JSON.parse(body) as { name: string }).name
        res.end(JSON.stringify({ project }))
      } else {
        res.statusCode = 404
        res.end(JSON.stringify({ error: 'not found' }))
      }
    })
  })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, project }
}

afterEach(async () => {
  if (server) await new Promise((resolve) => server!.close(resolve))
  server = null
})

describe('BrainProjectsClient.rename', () => {
  it('writes the name to the brain and drops the cached list', async () => {
    const brain = await fakeBrain()
    const client = new BrainProjectsClient(brain.url, 'tok')
    expect((await client.list())[0].name).toBe('Alpha')

    await client.rename('alpha', 'Completely different')

    const put = brain.seen.find((r) => r.method === 'PUT')
    expect(put).toMatchObject({ url: '/object/project/alpha', auth: 'Bearer tok' })
    expect(JSON.parse(put!.body)).toEqual({ name: 'Completely different' })
    expect(client.cached()).toBeNull()
    expect((await client.list())[0]).toMatchObject({ id: 'alpha', name: 'Completely different' })
  })

  it('reports the status when the brain has no such project', async () => {
    const brain = await fakeBrain()
    const client = new BrainProjectsClient(brain.url, 'tok')
    await expect(client.rename('missing', 'x')).rejects.toMatchObject({ status: 404 })
    await expect(client.rename('missing', 'x')).rejects.toBeInstanceOf(BrainRenameError)
  })
})
