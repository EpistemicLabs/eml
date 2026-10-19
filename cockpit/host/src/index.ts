#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_HOOK_CURL_CONFIG, COCKPIT_HOME, SPAWN_CLI_JS, SPAWN_INBOX_DIR, TASKS_DIR } from './paths.js'
import { watchSpawnInbox } from './spawn-inbox.js'
import { loadBrain } from './provision.js'
import { readCockpitConfig } from './config.js'
import { runFirstRunSetup } from './setup.js'
import { startOnboarding } from './onboarding.js'
import { BrainHygiene } from './brain-hygiene.js'
import { launchBrainServer } from './server-launch.js'
import { ProviderRegistry } from './infrastructure/providers/registry.js'
import { SessionLedger } from './session-ledger.js'
import { readDefaultProvider } from './provider-settings.js'
import { PtyBridge } from './pty-bridge.js'
import { ABOUT, createHostServer } from './http.js'
import { getFreePort } from './ports.js'
import { TurnTracker } from './turn-state.js'
import { brainForLocalToken } from './brain-info.js'
import { BrainSpaces, openBrainSpace } from './brain-space.js'
import { SpawnQueue } from './spawn-queue.js'
import { runServiceCommand } from './service.js'
import { scheduleUpdateChecks } from './app-update.js'

/**
 * Cockpit host entrypoint: set up the cockpit's own Claude Code → load the local
 * brain (a fresh home first runs the first-run setup, setup.ts) → launch the bundled loopback server → write isolation files →
 * start the http+ws host → open the tab.
 *
 * `eml-cockpit service …` is handled first (autostart install/uninstall/status)
 * and exits; with no subcommand the host boots normally.
 */

const log = (s: string) => process.stderr.write(s + '\n')

function openBrowser(url: string): void {
  if (process.env.COCKPIT_NO_OPEN) return
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try { spawn(opener, [url], { stdio: 'ignore', detached: true }).unref() } catch { /* headless */ }
}

// A port already taken (usually a host left over from an earlier start) must
// be a loud failure, not a silent exit that leaves the old process serving old code.
function portError(err: NodeJS.ErrnoException, port: number): Error {
  if (err.code !== 'EADDRINUSE') return err
  return new Error(
    `port ${port} is already in use — another cockpit host is still running. ` +
    `Find it with: lsof -nP -iTCP:${port} -sTCP:LISTEN — stop it, then start again.`,
  )
}

async function main() {
  log('== EML Cockpit host ====================================================')
  // The home holds the brain, tokens and transcripts: owner-only.
  fs.mkdirSync(COCKPIT_HOME, { recursive: true, mode: 0o700 })
  fs.chmodSync(COCKPIT_HOME, 0o700)
  log(`home: ${COCKPIT_HOME}`)

  // The cockpit's own agent CLIs (for Claude Code: providers/claude/runtime.ts).
  // Downloads only when this home has none yet. Not awaited: the first download
  // can take minutes, and the brain server, the migration and the UI must not
  // wait for it. Until it is done, or if it fails, sessions say what's missing
  // (Settings › Models retries).
  const ledger = new SessionLedger()
  const providers = new ProviderRegistry({ providerOf: (sessionId) => ledger.get(sessionId)?.provider, preferred: readDefaultProvider })
  for (const provider of providers.all()) {
    const name = provider.label.toLowerCase()
    void provider.runtime.install().finally(() => {
      const runtime = provider.runtime.version()
      const error = provider.runtime.lastError()
      log(runtime
        ? `${name}: ${runtime} (cockpit-owned)`
        // Without an error nothing went wrong: the CLI is installed when the user asks (Settings › Models).
        : `${name}: not set up${error ? ` — ${error}` : ' (installed on request)'}`)
    })
    provider.runtime.scheduleUpdates()
  }
  scheduleUpdateChecks()

  // The host port is needed before the brain (a fresh home serves the setup
  // on it) and before the isolation files: the session hooks report turn
  // state to POST /api/hook.
  const hostPort = Number(process.env.COCKPIT_PORT) || (await getFreePort())
  const url = `http://127.0.0.1:${hostPort}`
  const origins = [url, `http://localhost:${hostPort}`]

  let brain = await loadBrain()
  if (!brain) {
    brain = await runFirstRunSetup({
      port: hostPort,
      allowedOrigins: origins,
      onListening: (setupUrl) => {
        log(`first run: setup at ${setupUrl}`)
        openBrowser(setupUrl)
      },
    }).catch((err: NodeJS.ErrnoException) => { throw portError(err, hostPort) })
  }
  log(`brain: ${brain.reused ? 'loaded existing' : 'provisioned fresh'} (token in-process)`)

  const server = await launchBrainServer()
  log(`brain server: ${server.baseUrl} (healthy)`)

  // The per-boot token keeps other local processes from spoofing session state.
  const hookToken = randomBytes(16).toString('hex')
  const hookUrl = `http://127.0.0.1:${hostPort}/api/hook`

  // Each agent CLI writes the files its sessions share across spaces (for
  // Claude Code: the hook curl config, the skills, .claude.json; for Codex:
  // config.toml and hooks.json). A space's own files follow below.
  for (const provider of providers.all()) {
    provider.prepare({ hookUrl, hookToken, writableDirs: [SPAWN_INBOX_DIR, TASKS_DIR] })
  }
  log('isolation files written (CLAUDE_CONFIG_DIR, CODEX_HOME)')

  // The brain spaces (brain-space.ts): the local brain this home was
  // provisioned with (main) plus the further local brains of the config. Each
  // space writes its own session files.
  const config = await readCockpitConfig()
  const row = brainForLocalToken(brain.token)
  const main = openBrainSpace({
    id: row?.id ?? 'main',
    name: config?.mainName ?? 'Main',
    brainName: row?.name ?? 'main',
    main: true,
    url: server.baseUrl,
    token: brain.token,
    hookUrl,
    curlConfig: CLAUDE_HOOK_CURL_CONFIG,
  })
  const spaces = new BrainSpaces(main)
  for (const extra of config?.spaces ?? []) {
    const extraRow = brainForLocalToken(extra.token)
    if (!extraRow) { log('space: a configured token matches no brain — skipped'); continue }
    spaces.add(openBrainSpace({
      id: extraRow.id, name: extra.name ?? extraRow.name, brainName: extraRow.name, main: false,
      url: server.baseUrl, token: extra.token, hookUrl, curlConfig: CLAUDE_HOOK_CURL_CONFIG,
    }))
  }
  log(`spaces: ${spaces.list().map((s) => `${s.name} (${s.registry.list().length} local projects)`).join(', ')}`)

  // Sessions can open worker sessions (skill spawn-session → cockpit-spawn →
  // POST /api/spawn); the per-boot token keeps other local processes out.
  const spawns = new SpawnQueue()
  const spawnToken = randomBytes(24).toString('hex')
  const sessionEnv = {
    COCKPIT_URL: `http://127.0.0.1:${hostPort}`,
    COCKPIT_SPAWN_TOKEN: spawnToken,
    COCKPIT_SPAWN_JS: SPAWN_CLI_JS,
    // Where a session without network leaves its worker request (spawn-inbox.ts).
    COCKPIT_SPAWN_DIR: SPAWN_INBOX_DIR,
    // v0.17 task runs (skill task-run): the home of a task's files when its
    // project has no folder of its own (<home>/tasks/<title>).
    COCKPIT_TASKS_DIR: TASKS_DIR,
  }
  fs.mkdirSync(TASKS_DIR, { recursive: true })
  watchSpawnInbox({ spawns, spawnToken, spaces, ledger, providers })
  const bridge = new PtyBridge({ ledger, providers, spaces, sessionEnv })
  const swept = bridge.sweepEmptySessions()
  if (swept > 0) process.stderr.write(`[pty] forgot ${swept} session(s) that never ran a turn\n`)
  const turns = new TurnTracker()
  // Notification types that don't mean "waiting" — logged so new ones can be classified.
  turns.on('notification', (type: string) => { if (type !== 'idle_prompt') log(`[turn] notification ${type}`) })

  // Brain hygiene: the open space's banner offers a session (brain-hygiene.ts).
  const hygiene = new BrainHygiene({ spawns, log, isReady: () => providers.default().auth.signedIn() })

  const host = createHostServer(
    { spaces, bridge, turns, providers, hookToken, hookUrl, curlConfig: CLAUDE_HOOK_CURL_CONFIG, spawns, spawnToken, hygiene },
    origins,
  )

  await new Promise<void>((resolve, reject) => {
    host.once('error', (err: NodeJS.ErrnoException) => reject(portError(err, hostPort)))
    host.listen(hostPort, '127.0.0.1', resolve)
  })
  log(`cockpit: ${url}`)
  log(`host: v${ABOUT.version}`)

  if (brain.onboarding === 'pending') {
    startOnboarding({ projects: main.registry, spawns, isClaudeReady: () => providers.get('claude')?.auth.signedIn() ?? Promise.resolve(false) })
    log('first run: getting-started session opens once Claude Code is signed in')
  }

  // After a first-run setup the setup page is already open and reloads itself.
  if (brain.reused) openBrowser(url)

  const shutdown = () => {
    try { bridge.dispose() } catch { /* best-effort */ }
    try { server.proc.kill('SIGTERM') } catch { /* best-effort */ }
    try { host.close() } catch { /* best-effort */ }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

runServiceCommand(process.argv.slice(2))
  .then((handled) => { if (!handled) return main() })
  .catch((e) => { log(`cockpit host error: ${e.message}`); process.exit(1) })
