import fs from 'fs'
import path from 'path'
import net from 'net'
import { spawn, type ChildProcess } from 'child_process'
import { createRequire } from 'module'

// --- System under test ----------------------------------------------------------
//
// The bench measures a BUILD of EML, not the code it ships with: a system under
// test is a checkout with built packages (core, server, mcp-server). The same
// bench therefore measures any version — the current branch, a release worktree,
// an older tag — through the interfaces an agent uses: the REST server, and in
// the agent stage the MCP server on top of it.

export interface Sut {
  root: string
  version: string
  coreDist: string
  serverEntry: string
  mcpEntry: string
}

export function openSut(root: string): Sut {
  const abs = path.resolve(root)
  const serverPkg = path.join(abs, 'packages/server/package.json')
  if (!fs.existsSync(serverPkg)) throw new Error(`not an EML checkout: ${abs} (no packages/server)`)
  const sut: Sut = {
    root: abs,
    version: JSON.parse(fs.readFileSync(serverPkg, 'utf8')).version,
    coreDist: path.join(abs, 'packages/core/dist/index.js'),
    serverEntry: path.join(abs, 'packages/server/dist/server.js'),
    mcpEntry: path.join(abs, 'packages/mcp-server/dist/cli.js'),
  }
  for (const f of [sut.coreDist, sut.serverEntry]) {
    if (!fs.existsSync(f)) throw new Error(`${f} missing — build the checkout first (pnpm install && pnpm build)`)
  }
  return sut
}

/** The SUT's own core package (provisioning, control DB) — loaded from its dist. */
export function sutCore(sut: Sut): any {
  return createRequire(sut.coreDist)(sut.coreDist)
}

/** The SUT's better-sqlite3, so the brain file is opened with the version it was written by. */
export function sutSqlite(sut: Sut): any {
  return createRequire(sut.coreDist)('better-sqlite3')
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

export interface RunningServer {
  url: string
  stop(): Promise<void>
}

/**
 * Starts the SUT's REST server on a data dir. The server runs the forward
 * migrations of every brain in the data dir at startup — a brain written by an
 * older version is measured the way a user has it after the update.
 */
export async function startServer(sut: Sut, dataDir: string, logFile: string): Promise<RunningServer> {
  const port = await freePort()
  const log = fs.openSync(logFile, 'a')
  const child: ChildProcess = spawn(process.execPath, [sut.serverEntry, '--data-dir', dataDir, '--port', String(port)], {
    cwd: dataDir,
    // No .env from the working directory, no review sweep surprises from the caller's env.
    env: { PATH: process.env.PATH ?? '', EML_ENV_FILE: path.join(dataDir, 'no.env') },
    stdio: ['ignore', log, log],
  })
  const url = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 60_000
  let exited = false
  child.on('exit', () => { exited = true })
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited during startup — see ${logFile}`)
    try {
      const res = await fetch(`${url}/health`)
      if (res.ok) break
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100))
  }
  if (Date.now() >= deadline) { child.kill(); throw new Error(`server did not come up — see ${logFile}`) }
  return {
    url,
    stop: () => new Promise<void>(resolve => {
      if (exited) return resolve()
      child.once('exit', () => { fs.closeSync(log); resolve() })
      child.kill('SIGTERM')
    }),
  }
}

export class Api {
  constructor(private url: string, private token: string) {}

  async call(method: 'GET' | 'POST', route: string, body?: unknown): Promise<any> {
    const res = await fetch(`${this.url}${route}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${route} → ${res.status}: ${text}`)
    return text ? JSON.parse(text) : null
  }
}
