#!/usr/bin/env node
/**
 * Smoke test of the built cockpit on the OS it runs on (CI: Linux, macOS,
 * Windows). Starts the real host in a throwaway home and goes through what a
 * new user's first start does, without a browser and without a sign-in:
 *
 *   1. first-run setup over its API (names → a fresh brain)
 *   2. the host comes up, health answers
 *   3. Claude Code: the real download, checksum and --version self-test
 *   4. Codex: the real npm download, unpack (the system tar) and self-test
 *   5. the hooks exactly as the agent CLIs store them, run the way each CLI
 *      runs them on this OS (Windows: Claude Code without a shell, Codex in
 *      PowerShell; elsewhere sh): the turn hook reaches the host and moves
 *      the session's turn state, the EML boot hook prints the brain's boot
 *   6. the diagnostics a session's report-issue runs: listed, and redacted
 *
 * Needs `pnpm build` and `pnpm -F eml-cockpit build` first.
 *
 *   node scripts/smoke-test.mjs [--skip-codex]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_JS = join(ROOT, 'cockpit', 'host', 'dist', 'index.js')
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000
const WINDOWS = process.platform === 'win32'

const step = (s) => console.log(`\n▶ ${s}`)
const ok = (s) => console.log(`  ✓ ${s}`)
const fail = (s) => { throw new Error(s) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function freePort() {
  const server = createServer()
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  await new Promise((r) => server.close(r))
  return port
}

async function until(what, timeoutMs, probe) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try { const value = await probe(); if (value) return value } catch (e) { last = e }
    await sleep(1000)
  }
  fail(`timed out waiting for ${what}${last ? ` (${last.message})` : ''}`)
}

/** Run a command with stdin and env; resolves with exit code and output. */
function run(cmd, args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (e) => resolve({ code: -1, stdout, stderr: String(e) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

if (!existsSync(HOST_JS)) fail(`${HOST_JS} is missing — run pnpm build and pnpm -F eml-cockpit build first`)

const home = mkdtempSync(join(tmpdir(), 'cockpit-smoke-'))
const port = await freePort()
const base = `http://127.0.0.1:${port}`
const headers = { 'content-type': 'application/json', origin: base }
let hostLog = ''
const host = spawn(process.execPath, [HOST_JS], {
  env: { ...process.env, EML_COCKPIT_HOME: home, COCKPIT_PORT: String(port), COCKPIT_NO_OPEN: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
host.stdout.on('data', (c) => { hostLog += c })
host.stderr.on('data', (c) => { hostLog += c })
const hostExited = new Promise((r) => host.on('exit', r))

const api = async (path, init) => {
  const res = await fetch(`${base}${path}`, init)
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** The turn state the host holds for a session (GET /api/events, first snapshot). */
async function turnState(sessionId) {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/events`, { signal: controller.signal })
  const reader = res.body.getReader()
  let text = ''
  try {
    while (!/event: snapshot\ndata: .*\n/.test(text)) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
  } finally {
    controller.abort()
  }
  const snapshot = JSON.parse(/event: snapshot\ndata: (.*)\n/.exec(text)[1])
  return snapshot.find((t) => t.sessionId === sessionId)?.state ?? null
}

/**
 * The ways a CLI runs a stored hook on this OS, each as a runner. Claude Code:
 * the exec form without a shell where the hook has args (Windows), else sh.
 * Codex on Windows: pwsh when installed, else Windows PowerShell 5.1 — both
 * must work. Elsewhere sh.
 */
function shellsFor(cli, hook) {
  if (cli === 'claude' && Array.isArray(hook.args)) return [['exec form', (opts) => run(hook.command, hook.args, opts)]]
  if (cli === 'codex' && WINDOWS) {
    return ['powershell.exe', 'pwsh'].map((ps) => [ps, (opts) => run(ps, ['-NoProfile', '-Command', hook.command], opts)])
  }
  return [['sh', (opts) => run('sh', ['-c', hook.command], opts)]]
}

async function checkHooks(cli, hooks, env) {
  const turn = hooks.UserPromptSubmit[0].hooks[0]
  const boot = hooks.SessionStart[0].hooks[0]
  for (const [shell, runIn] of shellsFor(cli, turn)) {
    const sessionId = `smoke-${cli}-${shell.replace(/\W/g, '')}`
    const result = await runIn({
      input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sessionId }),
      env: { ...env, COCKPIT_SESSION_ID: sessionId },
    })
    if (result.code !== 0) fail(`${cli} turn hook (${shell}) exited ${result.code}: ${result.stderr.slice(0, 300)}`)
    await until(`${cli} turn state (${shell})`, 10_000, async () => (await turnState(sessionId)) === 'working')
    ok(`${cli} turn hook (${shell}) → turn state working`)
  }
  for (const [shell, runIn] of shellsFor(cli, boot)) {
    const result = await runIn({ input: '{}', env })
    if (result.code !== 0 || !result.stdout.includes('EML Boot')) {
      fail(`${cli} boot hook (${shell}) printed no boot (exit ${result.code}): ${(result.stderr || result.stdout).slice(0, 300)}`)
    }
    ok(`${cli} EML boot hook (${shell}) → boot printed`)
  }
}

try {
  step('first-run setup')
  await until('the setup server', 60_000, async () => (await api('/api/setup')).body?.needed === true)
  const setup = await api('/api/setup', { method: 'POST', headers, body: JSON.stringify({ userName: 'Smoke User', agentName: 'Smoke Agent' }) })
  if (setup.status >= 300) fail(`setup answered ${setup.status}: ${JSON.stringify(setup.body)}`)
  ok('brain provisioned')

  step('host')
  await until('the host', 120_000, async () => (await api('/api/setup')).body?.needed === false)
  ok(`host up on ${base}`)

  const runtime = async (id) => {
    const provider = (await api('/api/providers')).body?.providers?.find((p) => p.id === id)
    if (provider?.version) return provider.version
    const result = provider?.runtime?.lastResult
    if (result?.outcome === 'failed') fail(`${id} install failed: ${result.error}`)
    return null
  }

  step('Claude Code runtime (download, checksum, self-test)')
  ok(`claude ${await until('Claude Code', DOWNLOAD_TIMEOUT_MS, () => runtime('claude'))}`)

  if (!process.argv.includes('--skip-codex')) {
    step('Codex runtime (npm download, unpack, self-test)')
    await api('/api/providers/codex/runtime/check', { method: 'POST', headers, body: '{}' })
    ok(`codex ${await until('Codex', DOWNLOAD_TIMEOUT_MS, () => runtime('codex'))}`)
  }

  step('hooks, as the CLIs run them')
  const spaces = join(home, 'claude-config', 'spaces')
  const [space] = readdirSync(spaces)
  const claudeHooks = JSON.parse(readFileSync(join(spaces, space, 'settings.json'), 'utf8')).hooks
  await checkHooks('claude', claudeHooks, {})
  const codexHooks = JSON.parse(readFileSync(join(home, 'codex-config', 'hooks.json'), 'utf8')).hooks
  await checkHooks('codex', codexHooks, { EML_HOOK_CONFIG: join(home, 'eml', 'spaces', space, 'config') })

  step('diagnostics, as a session runs them')
  const diag = await run(process.execPath, [join(ROOT, 'cockpit', 'host', 'dist', 'diagnose-cli.js')], {
    env: { EML_COCKPIT_HOME: '', COCKPIT_HOME: home, COCKPIT_URL: base },
  })
  if (diag.code !== 0 || !diag.stdout.includes('### Diagnostics')) fail(`diagnose exited ${diag.code}: ${diag.stderr.slice(0, 300)}`)
  if (!/claude code: \d/.test(diag.stdout)) fail(`diagnose shows no Claude Code version:\n${diag.stdout.slice(0, 600)}`)
  if (diag.stdout.includes(home) || diag.stdout.toLowerCase().includes(homedir().toLowerCase())) fail('diagnose printed a home path')
  ok('diagnose: versions and runtimes listed, no home path')

  console.log('\nsmoke test passed')
} catch (e) {
  console.error(`\n✗ ${e.message}\n\n--- host log ---\n${hostLog.slice(-6000)}`)
  process.exitCode = 1
} finally {
  host.kill()
  await Promise.race([hostExited, sleep(5000)])
  // The brain server exits once the host is gone (brain-watchdog.ts); its files may stay locked a moment.
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}
