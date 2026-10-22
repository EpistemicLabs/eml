import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { initControlDatabase } from '@engramprotocol/core'

/**
 * Smoke test for GET /health (v0.9-PROPOSAL §5.10).
 *
 * Spawns the built server process against a temp DATA_DIR and asserts
 * that /health is publicly accessible and returns the spec format:
 * { status, version, uptime_sec }.
 */

interface HealthResponse {
  status: string
  version: string
  uptime_sec: number
}

function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number, body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
          resolve({ status: res.statusCode || 0, body })
        } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.setTimeout(3000, () => req.destroy(new Error('request timeout')))
  })
}

function waitForReady(port: number, timeoutMs = 5000): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const req = http.get(`http://127.0.0.1:${port}/health`, (res) => {
        res.resume()
        if (res.statusCode === 200) resolve()
        else if (Date.now() - start > timeoutMs) reject(new Error(`health never returned 200 (last=${res.statusCode})`))
        else setTimeout(tick, 100)
      })
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('server never came up'))
        else setTimeout(tick, 100)
      })
    }
    tick()
  })
}

describe('/health endpoint', () => {
  let serverProc: ChildProcess
  let tmpDir: string
  const port = 31170 + Math.floor(Math.random() * 100)

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'eml-health-test-'))
    // v0.9 multi-tenant: control.db must exist before the server starts.
    mkdirSync(join(tmpDir, 'brains'), { recursive: true })
    initControlDatabase(join(tmpDir, 'control.db')).close()

    serverProc = spawn('node', [join(__dirname, '..', 'dist', 'server.js')], {
      env: {
        ...process.env,
        EML_PORT: String(port),
        EML_HOST: '127.0.0.1',
        EML_DATA_DIR: tmpDir,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitForReady(port)
  }, 10000)

  afterAll(async () => {
    // Wait for the exit: Windows can't delete the brain files while the server holds them open.
    if (serverProc && serverProc.exitCode === null) await new Promise((resolve) => { serverProc.once('exit', resolve); serverProc.kill('SIGTERM') })
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GET /health returns 200 with status/version/uptime_sec (no auth)', async () => {
    const { status, body } = await getJson(`http://127.0.0.1:${port}/health`)
    expect(status).toBe(200)
    const health = body as HealthResponse
    expect(health.status).toBe('ok')
    expect(health.version).toMatch(/^\d+\.\d+\.\d+$/)
    expect(typeof health.uptime_sec).toBe('number')
    expect(health.uptime_sec).toBeGreaterThanOrEqual(0)
  })

  it('GET /health works WITHOUT Authorization header', async () => {
    const { status: healthStatus } = await getJson(`http://127.0.0.1:${port}/health`)
    expect(healthStatus).toBe(200)

    // Sanity: confirm a normal endpoint requires auth
    const { status: protectedStatus } = await getJson(`http://127.0.0.1:${port}/agents`)
    expect(protectedStatus).toBe(401)
  })

  it('uptime_sec increases over time', async () => {
    const a = await getJson(`http://127.0.0.1:${port}/health`)
    await new Promise(r => setTimeout(r, 1100))
    const b = await getJson(`http://127.0.0.1:${port}/health`)
    expect((b.body as HealthResponse).uptime_sec).toBeGreaterThan((a.body as HealthResponse).uptime_sec)
  })

  it('HEAD /health returns 200 (semantically GET without body) — no auth required', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({
        method: 'HEAD',
        hostname: '127.0.0.1',
        port,
        path: '/health',
      }, (res) => {
        res.resume()
        resolve(res.statusCode || 0)
      })
      req.on('error', reject)
      req.setTimeout(3000, () => req.destroy(new Error('timeout')))
      req.end()
    })
    expect(status).toBe(200)
  })
})
