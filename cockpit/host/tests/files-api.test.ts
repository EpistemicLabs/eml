import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { extractFileRefs, fileKind } from '../src/domain/file-refs.js'
import { createRecentFiles, fileRequestAllowed, handleFilesApi, resolveRef, statFile, type FilesDeps } from '../src/files-api.js'

describe('extractFileRefs', () => {
  it('finds absolute, home and relative paths of the kinds the viewer shows', () => {
    const text = 'Wrote /tmp/out/report.csv and ~/exports/chart.png, see reports/review.pdf and notes.md.'
    expect(extractFileRefs(text)).toEqual(['/tmp/out/report.csv', '~/exports/chart.png', 'reports/review.pdf', 'notes.md'])
  })

  it('reads paths with spaces inside backticks and markdown links', () => {
    const text = 'The file `/home/me/My Files/plan v2.md` and [the chart](</srv/a b/c.png>) and [x](./rel/d.csv)'
    expect(extractFileRefs(text)).toEqual(['/home/me/My Files/plan v2.md', '/srv/a b/c.png', './rel/d.csv'])
  })

  it('leaves URLs, other extensions and repeats out', () => {
    const text = 'https://example.com/a.png and http://x.io/b.pdf, /tmp/a.ts, /tmp/c.csv twice: /tmp/c.csv'
    expect(extractFileRefs(text)).toEqual(['/tmp/c.csv'])
  })

  it('knows the kinds by extension', () => {
    expect(fileKind('/a/b.TSV')).toBe('csv')
    expect(fileKind('x.jpeg')).toBe('image')
    expect(fileKind('x.markdown')).toBe('markdown')
    expect(fileKind('x.xlsx')).toBeNull()
  })
})

describe('files', () => {
  let dir: string
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-api-'))
    fs.writeFileSync(path.join(dir, 'data.csv'), 'a,b\n1,2\n')
    fs.writeFileSync(path.join(dir, 'page.html'), '<script>alert(1)</script>')
    fs.mkdirSync(path.join(dir, 'folder.md'))
  })
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('resolves home and relative paths', () => {
    expect(resolveRef('~/x.md', null)).toBe(path.join(os.homedir(), 'x.md'))
    expect(resolveRef('x.md', null)).toBeNull()
    expect(resolveRef('sub/x.md', path.resolve('/work'))).toBe(path.resolve('/work', 'sub/x.md'))
  })

  it('stats only existing regular files of a known kind', () => {
    expect(statFile('data.csv', dir)).toMatchObject({ path: path.join(dir, 'data.csv'), name: 'data.csv', kind: 'csv', size: 8 })
    expect(statFile('missing.csv', dir)).toBeNull()
    expect(statFile('folder.md', dir)).toBeNull()
    expect(statFile('page.html', dir)).toBeNull()
  })

  it('collects the recent files of chats, newest mention first, cached per chat', async () => {
    let reads = 0
    const now = new Date().toISOString()
    const before = new Date(Date.now() - 1000).toISOString()
    const deps: FilesDeps = {
      cwdOf: () => dir,
      recentSessions: () => [
        { sessionId: 's2', title: 'Newer', projectId: 'p', spaceId: null, lastActivity: now },
        { sessionId: 's1', title: 'Older', projectId: 'p', spaceId: null, lastActivity: before },
        { sessionId: 'old', title: 'Old', projectId: 'p', spaceId: null, lastActivity: '2020-01-01T00:00:00.000Z' },
      ],
      replyTexts: async (id) => { reads += 1; return id === 'old' ? ['data.csv'] : ['Here: out/../data.csv', 'and missing.md'] },
    }
    const recent = createRecentFiles(deps)
    const files = await recent()
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ name: 'data.csv', sessionId: 's2', sessionTitle: 'Newer' })
    await recent()
    expect(reads).toBe(2)
  })
})

describe('the file route', () => {
  let dir: string
  let server: http.Server
  let base: string
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'files-route-'))
    fs.writeFileSync(path.join(dir, 'pic.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    fs.writeFileSync(path.join(dir, 'doc.pdf'), '%PDF-1.4')
    fs.writeFileSync(path.join(dir, 'page.html'), '<p>hi</p>')
    const deps: FilesDeps = { cwdOf: () => dir, recentSessions: () => [], replyTexts: async () => null }
    const json = (res: http.ServerResponse, status: number, payload: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(payload)) }
    const readJson = (req: http.IncomingMessage) => new Promise<Record<string, unknown>>((resolve) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c)).on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')))
    })
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      void handleFilesApi(req, res, deps, async () => [], url, req.method ?? 'GET', json, readJson).then((handled) => { if (!handled) { res.writeHead(404); res.end() } })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const get = (file: string, site?: string) => fetch(`${base}/api/file?path=${encodeURIComponent(file)}`, { headers: site ? { 'Sec-Fetch-Site': site } : {} })

  it('answers the cockpit page only', async () => {
    expect((await get(path.join(dir, 'pic.svg'))).status).toBe(403)
    expect((await get(path.join(dir, 'pic.svg'), 'cross-site')).status).toBe(403)
    expect((await get(path.join(dir, 'pic.svg'), 'same-site')).status).toBe(403)
    expect((await get(path.join(dir, 'pic.svg'), 'same-origin')).status).toBe(200)
    expect(fileRequestAllowed({ headers: { 'sec-fetch-site': 'none' } } as unknown as http.IncomingMessage)).toBe(true)
  })

  it('serves a file sandboxed under its type; a PDF without the sandbox; anything else as a download', async () => {
    const svg = await get(path.join(dir, 'pic.svg'), 'same-origin')
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff')
    const pdf = await get(path.join(dir, 'doc.pdf'), 'same-origin')
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(pdf.headers.get('content-security-policy')).toBeNull()
    const html = await get(path.join(dir, 'page.html'), 'same-origin')
    expect(html.headers.get('content-type')).toBe('application/octet-stream')
    expect(html.headers.get('content-disposition')).toContain('attachment')
  })

  it('refuses relative paths, folders and missing files', async () => {
    expect((await get('pic.svg', 'same-origin')).status).toBe(400)
    expect((await get(dir, 'same-origin')).status).toBe(404)
    expect((await get(path.join(dir, 'nope.png'), 'same-origin')).status).toBe(404)
  })

  it('stats what a message names, relative to the session folder', async () => {
    const res = await fetch(`${base}/api/files/stat`, { method: 'POST', body: JSON.stringify({ refs: ['pic.svg', 'doc.pdf', 'page.html', 'gone.md'], sessionId: 's' }) })
    const body = await res.json() as { files: Array<{ name: string; kind: string }> }
    expect(body.files.map((f) => [f.name, f.kind])).toEqual([['pic.svg', 'image'], ['doc.pdf', 'pdf']])
  })
})
