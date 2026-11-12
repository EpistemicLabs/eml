#!/usr/bin/env node
// First: a host without a console sends its output to its log file from here on (log-file.ts).
import './log-file.js'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_TURN_HOOK_CONFIG, COCKPIT_HOME, DIAGNOSE_CLI_JS, SESSION_DIRECTORY_CLI_JS, SESSION_MESSAGE_CLI_JS, MESSAGE_TOKEN_FILE, SESSION_TITLE_CLI_JS, SPAWN_CLI_JS, SPAWN_INBOX_DIR, TASKS_DIR } from './paths.js'
import { watchSpawnInbox } from './spawn-inbox.js'
import { fillHumanName, loadBrain } from './provision.js'
import { readCockpitConfig, writeCockpitConfig } from './config.js'
import { runFirstRunSetup } from './setup.js'
import { startOnboarding } from './onboarding.js'
import { BrainHygiene } from './brain-hygiene.js'
import { launchBrainServer } from './server-launch.js'
import { ProviderRegistry } from './infrastructure/providers/registry.js'
import { SessionLedger } from './session-ledger.js'
import { readDefaultProvider } from './provider-settings.js'
import { PtyBridge } from './pty-bridge.js'
import { ChatBridge } from './chat-bridge.js'
import { terminalBusyState } from './domain/session-lifecycle.js'
import { StartWorker } from './application/start-worker.js'
import { deliverMessage, type MessageRequest } from './application/deliver-message.js'
import { interruptedWorkers, recoverWorkers } from './application/recover-workers.js'
import { shutDownOnSignal } from './application/shut-down.js'
import { needsAnswer } from './domain/session-attention.js'
import type { SpawnRequest } from './domain/spawn-request.js'
import { loadMessageToken } from './message-token.js'
import { sessionAddress } from './session-address.js'
import { InMemoryEventStore } from './application/session-events.js'
import { SessionHandoff } from './application/session-handoff.js'
import { createClaudeSdkRuntimes } from './infrastructure/providers/claude/sdk-runtime.js'
import { ABOUT, createHostServer } from './http.js'
import { getFreePort } from './ports.js'
import { TurnTracker } from './turn-state.js'
import { brainForLocalToken } from './brain-info.js'
import { BrainSpaces, openBrainSpace, sessionSpaceOf } from './brain-space.js'
import { HOOKS_PATH, MCP_PATH, createBrainMcpHandler } from './brain-mcp.js'
import { loadAgentBrains } from './agents.js'
import { upgradeAtStart } from './agent-upgrade.js'
import { runUpgradeAgentsCommand } from './agent-upgrade-cli.js'
import { BACKUPS_DIR, DATA_DIR } from './paths.js'
import type { UpgradeState } from './brain-space.js'
import { loadSharedFlags, sweepOrphanBrains } from './team-space.js'
import { SpawnQueue } from './spawn-queue.js'
import { WorkerStarter } from './worker-start.js'
import { refreshServiceUnit, runServiceCommand } from './service.js'
import { SERVICE_ENV } from './domain/autostart.js'
import { idleMs, readLimits, sessionLimits } from './session-limits.js'
import { runRemoteCommand } from './remote.js'
import { runAgentCommand } from './agent-command.js'
import { scheduleUpdateChecks } from './app-update.js'
import { platform } from './infrastructure/platform/index.js'

/**
 * Cockpit host entrypoint: set up the cockpit's own Claude Code → load the local
 * brain (a fresh home first runs the first-run setup, setup.ts) → launch the bundled loopback server → write isolation files →
 * start the http+ws host → open the tab.
 *
 * `eml-cockpit service …` (autostart install/uninstall/status) and
 * `eml-cockpit diagnose` (redacted diagnostics for an issue) and
 * `eml-cockpit agent …` (a space's own agent, agent-command.ts) are handled first
 * and exit; with no subcommand the host boots normally.
 */

const log = (s: string) => process.stderr.write(s + '\n')

function openBrowser(url: string): void {
  if (process.env.COCKPIT_NO_OPEN) return
  platform.openUrl(url)
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
  // Run by the service: its unit first, then a memory ceiling per session (session-memory.ts).
  const service = process.env[SERVICE_ENV] === '1'
  if (service) refreshServiceUnit(log)
  const memory = platform.sessionMemory({ service, log })
  log(memory.unavailable ? `memory: sessions run without a ceiling (${memory.unavailable})` : 'memory: every session gets its own memory ceiling')

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
  // The brain MCP endpoint every session reaches its brains through, and the
  // hook routes the session hooks read from (brain-mcp.ts).
  const mcpUrl = `http://127.0.0.1:${hostPort}${MCP_PATH}`
  const hooksUrl = `http://127.0.0.1:${hostPort}${HOOKS_PATH}`

  // Each agent CLI writes the files its sessions share across spaces (for
  // Claude Code: the turn-hook config, the skills, .claude.json; for Codex:
  // config.toml and hooks.json). A space's own files follow below.
  for (const provider of providers.all()) {
    provider.prepare({ hookUrl, hookToken, mcpUrl, writableDirs: [SPAWN_INBOX_DIR, TASKS_DIR] })
  }
  log('isolation files written (CLAUDE_CONFIG_DIR, CODEX_HOME)')

  // The agent brains (agents.ts) and the brain spaces (brain-space.ts): the
  // local brain this home was provisioned with (main) plus the further local
  // brains of the config, each bound to one agent. Each space writes its own
  // session files. A space without a bound agent (a home from before agent
  // brains, until the agent upgrade) gets no brain in its sessions.
  // A home from before agent brains gets them now (agent-upgrade.ts): a dry
  // run on copies, the real run only when every check passed, the config last.
  // When it cannot (no handle to tell, a check failed), the spaces stay
  // unbound and carry the reason for the banner and the boot refusal.
  // The config as the file has it after the upgrade, whatever its outcome, and why a space stayed unbound.
  const { config, upgrade, states: upgradeStates } = await upgradeAtStart({
    dataDir: DATA_DIR, backupsDir: BACKUPS_DIR, readConfig: readCockpitConfig, writeConfig: (next) => writeCockpitConfig(next), log,
  })
  const upgradeStateOf = (brainId: string, bound: string | null | undefined): UpgradeState | null => (bound ? null : upgrade ?? upgradeStates.get(brainId) ?? null)
  const agents = loadAgentBrains(config, server.baseUrl, log)
  const row = brainForLocalToken(config?.token ?? brain.token)
  const main = openBrainSpace({
    id: row?.id ?? 'main',
    name: config?.mainName ?? 'Main',
    agent: config?.agent ?? null,
    ownRuntime: agents.expectsRuntime(config?.agent),
    upgrade: upgradeStateOf(row?.id ?? 'main', config?.agent),
    main: true,
    color: config?.mainColor,
    url: server.baseUrl,
    token: config?.token ?? brain.token,
    turnHookConfig: CLAUDE_TURN_HOOK_CONFIG,
    mcpUrl,
    hooksUrl,
  })
  const spaces = new BrainSpaces(main, config?.spaceOrder)
  for (const extra of config?.spaces ?? []) {
    const extraRow = brainForLocalToken(extra.token)
    if (!extraRow) { log('space: a configured token matches no brain — skipped'); continue }
    spaces.add(openBrainSpace({
      id: extraRow.id, name: extra.name ?? extraRow.name, agent: extra.agent ?? null, upgrade: upgradeStateOf(extraRow.id, extra.agent), main: false, color: extra.color,
      url: server.baseUrl, token: extra.token, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, mcpUrl, hooksUrl, ownRuntime: agents.expectsRuntime(extra.agent),
    }))
    const runtime = spaces.get(extraRow.id)?.runtime
    const problem = runtime?.problem('claude')
    if (runtime) log(`space ${extra.name ?? extraRow.name}: runtime of ${runtime.id}${problem ? ` — ${problem}` : ''}`)
  }
  // v0.21: which spaces are shared brains, from the brain server (team-space.ts).
  await loadSharedFlags(spaces.list())
  // The human's name moves into the config once (after the agent upgrade, which sets the handle).
  await fillHumanName(log).catch((err: Error) => log(`human: ${err.message}`))
  log(`agents: ${agents.list().map((a) => a.id).join(', ') || 'none'}${config?.handle ? ` (handle ${config.handle})` : ''}`)
  log(`spaces: ${spaces.list().map((s) => `${s.name}${s.shared ? ' (shared)' : s.shared === null ? ' (shared?)' : ''} → ${s.agent ?? 'no agent'} (${s.registry.list().length} local projects)`).join(', ')}`)
  // A brain no token of the config belongs to is one a shared-space creation
  // or join left behind (a crash before the config was written): discarded
  // when it has no log, logged otherwise (team-space.ts). Runs after the agent
  // upgrade at host start (it writes its agent brains into the config last),
  // so a fresh agent brain never looks like an orphan — keep that order.
  await sweepOrphanBrains({
    // the main token as the config has it now: the agent upgrade may have re-issued it under the handle
    tokens: [config?.token ?? brain.token, ...(config?.spaces ?? []).map((s) => s.token), ...(config?.agents ?? []).map((a) => a.token)],
    url: server.baseUrl,
    log,
  }).catch((err: Error) => log(`sweep: ${err.message}`))

  // Sessions can open worker sessions (skill spawn-session → cockpit-spawn →
  // POST /api/spawn); the per-boot token keeps other local processes out.
  const spawns = new SpawnQueue()
  const spawnToken = randomBytes(24).toString('hex')
  const sessionEnv = {
    COCKPIT_URL: `http://127.0.0.1:${hostPort}`,
    COCKPIT_SPAWN_TOKEN: spawnToken,
    COCKPIT_SPAWN_JS: SPAWN_CLI_JS,
    // A greeted session names itself once it knows what it is about (session-greeting.ts).
    COCKPIT_TITLE_JS: SESSION_TITLE_CLI_JS,
    // A message that also reaches a stopped session (session-message-cli.ts).
    COCKPIT_MESSAGE_JS: SESSION_MESSAGE_CLI_JS,
    // Find a session by what the user calls it (session-directory-cli.ts).
    COCKPIT_SESSIONS_JS: SESSION_DIRECTORY_CLI_JS,
    // Redacted diagnostics for an issue (skill report-issue, diagnose-cli.ts).
    COCKPIT_DIAGNOSE_JS: DIAGNOSE_CLI_JS,
    COCKPIT_HOME,
    // Where a session without network leaves its worker request (spawn-inbox.ts).
    COCKPIT_SPAWN_DIR: SPAWN_INBOX_DIR,
    // v0.17 task runs (skill task-run): the home of a task's files when its
    // project has no folder of its own (<home>/tasks/<title>).
    COCKPIT_TASKS_DIR: TASKS_DIR,
  }
  fs.mkdirSync(TASKS_DIR, { recursive: true })
  const deliver = (request: MessageRequest) => deliverMessage({
    find: (target) => {
      const found = ledger.list().find((entry) => entry.sessionId === target || sessionAddress(entry.sessionId, entry.projectId) === target)
      return found ? { sessionId: found.sessionId, wakeable: found.wakeable } : null
    },
    terminalRuns: (sessionId) => bridge.isRunning(sessionId),
    runsInChat: (sessionId) => providers.forSession(sessionId)
      .workerRunsInChat(sessionSpaceOf(spaces.resolve(ledger.get(sessionId)?.spaceId ?? null))),
    chatRuns: (sessionId) => chat.isRunning(sessionId),
    sameReach: (fromSessionId, sessionId) => {
      const agentOf = (id: string) => spaces.resolve(ledger.get(id)?.spaceId ?? null).agent
      return ledger.get(fromSessionId) !== undefined && agentOf(fromSessionId) === agentOf(sessionId)
    },
    deliver: (sessionId, text) => chat.deliver(sessionId, text),
  }, request)
  watchSpawnInbox({ spawns, spawnToken, spaces, ledger, providers, deliver })
  // A conversation runs in one process, in the terminal or the chat view (session-handoff.ts).
  const handoff = (): SessionHandoff => sessionHandoff
  const bridge = new PtyBridge({
    ledger, providers, spaces, sessionEnv, handoff, chatHolds: (sessionId) => chat.isRunning(sessionId),
    memory, sessionLimits: () => sessionLimits(readLimits()),
  })
  // The cap on running sessions (Settings › Preferences › Sessions); 0: none.
  const running = (): number => chat.runningCount() + bridge.runningCount()
  const cap = () => readLimits().maxRunning
  const swept = bridge.sweepEmptySessions()
  if (swept > 0) process.stderr.write(`[pty] forgot ${swept} session(s) that never ran a turn\n`)
  const turns = new TurnTracker()
  const chat = new ChatBridge({
    ledger, providers, spaces, sessionEnv,
    runtimes: createClaudeSdkRuntimes(),
    events: new InMemoryEventStore(),
    onTurn: (sessionId, state) => turns.apply({ sessionId, state }),
    onExit: (sessionId) => turns.forget(sessionId),
    memory,
    limits: () => {
      const settings = readLimits()
      return { session: sessionLimits(settings), idleMs: idleMs(settings) }
    },
    overCap: (): boolean => cap() > 0 && running() > cap(),
    terminalRuns: (sessionId): boolean => bridge.isRunning(sessionId),
    terminalBusy: (sessionId): 'working' | 'waiting' | null => {
      const turn = turns.get(sessionId)
      return terminalBusyState({
        running: bridge.isRunning(sessionId),
        turn: turn ? { state: turn.state, since: Date.parse(turn.since) } : null,
        promptAt: bridge.promptAt(sessionId),
      })
    },
  }, handoff)
  const sessionHandoff = new SessionHandoff({ terminal: bridge, sdk: chat })
  // Turn state starts empty; what a session waits for someone about is saved.
  for (const { sessionId, attention } of ledger.list()) if (attention && needsAnswer(attention.kind)) turns.apply({ sessionId, state: 'waiting' })
  spawns.on('spawn', (request: SpawnRequest) => { if (request.fromSessionId) ledger.expectParent(request.id, request.fromSessionId) })
  const startWorker = new StartWorker({
    chat, terminal: bridge, log,
    runsInChat: (request) => (providers.get(request.provider ?? '') ?? providers.default())
      .workerRunsInChat(sessionSpaceOf(spaces.resolve(request.spaceId ?? null))),
    freeMemory: () => platform.freeMemory(),
    atCap: () => cap() > 0 && running() >= cap(),
    makeRoom: () => chat.stopOneForRoom(),
  })
  // Notification types that don't mean "waiting" — logged so new ones can be classified.
  turns.on('notification', (type: string) => { if (type !== 'idle_prompt') log(`[turn] notification ${type}`) })

  // Brain hygiene: the open space's banner offers a session (brain-hygiene.ts).
  const hygiene = new BrainHygiene({ spawns, log, isReady: () => providers.default().auth.signedIn() })

  const brainMcp = createBrainMcpHandler({ spaces, agents, ledger, providers, serverVersion: ABOUT.version })

  const host = createHostServer(
    { spaces, bridge, chat, turns, providers, memoryUnavailable: memory.unavailable, hookToken, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, spawns, workers: startWorker, spawnToken, outsideToken: loadMessageToken(MESSAGE_TOKEN_FILE), deliver, hygiene, agents, brainMcp, mcpUrl, hooksUrl },
    origins,
  )

  await new Promise<void>((resolve, reject) => {
    host.once('error', (err: NodeJS.ErrnoException) => reject(portError(err, hostPort)))
    host.listen(hostPort, '127.0.0.1', resolve)
  })
  log(`cockpit: ${url}`)
  // Sessions kept running for Remote Control come back without a browser,
  // once the host answers their hooks.
  const kept = bridge.resumeKeptSessions()
  if (kept > 0) log(`resumed ${kept} session(s) kept running for Remote Control`)
  // Workers a restart cut off mid-turn carry on, once the host answers their hooks.
  void recoverWorkers({
    interrupted: () => interruptedWorkers(ledger.list()),
    markRetried: (sessionId) => ledger.markTurnRetried(sessionId),
    giveUp: (sessionId, kind, reason) => {
      ledger.setTurnInFlight(sessionId, false)
      ledger.setAttention(sessionId, { kind, reason })
      turns.apply({ sessionId, state: 'waiting' })
    },
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }),
    waitForRoom: () => waitForRoom(() => startWorker.hasRoom()),
    log,
  }).then((recovered) => { if (recovered > 0) log(`[worker] ${recovered} worker(s) continue after the restart`) })
  // A worker no tab takes starts without a pane (worker-start.ts).
  const workers = new WorkerStarter({
    spawns, log,
    bridge: {
      startWorker: (request) => startWorker.withoutPane(request),
      hasRoom: () => startWorker.hasRoom(),
      sweepIdleWorkers: (quietMs, turnOf) => bridge.sweepIdleWorkers(quietMs, turnOf) + chat.sweepIdle(),
    },
    idleMs: () => idleMs(readLimits()),
    turnOf: (sessionId) => {
      const turn = turns.get(sessionId)
      return { state: turn?.state ?? 'idle', since: turn ? Date.parse(turn.since) : null }
    },
  })
  workers.start()
  log(`host: v${ABOUT.version}`)

  if (brain.onboarding === 'pending') {
    startOnboarding({ projects: main.registry, spawns, isClaudeReady: () => providers.get('claude')?.auth.signedIn() ?? Promise.resolve(false) })
    log('first run: getting-started session opens once Claude Code is signed in')
  }

  // After a first-run setup the setup page is already open and reloads itself.
  if (brain.reused) openBrowser(url)

  const shutdown = shutDownOnSignal({
    stop: () => {
      workers.stop()
      try { bridge.dispose() } catch { /* best-effort */ }
      try { host.close() } catch { /* best-effort */ }
    },
    drain: () => chat.dispose(),
    last: () => server.proc.kill('SIGTERM'),
    exit: (code) => process.exit(code),
    log,
  })
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

// Between two workers resumed after a restart: each one's start (agent CLI, MCP servers) settles first.
const RECOVERY_GAP_MS = 10_000
// Waiting longer than this for room, the worker goes anyway: a full machine must not hold it forever.
const RECOVERY_WAIT_MS = 10 * 60_000
let recoveries = 0

async function waitForRoom(hasRoom: () => boolean): Promise<void> {
  const pause = () => new Promise<void>((resolve) => { setTimeout(resolve, RECOVERY_GAP_MS).unref() })
  if (recoveries++ > 0) await pause()
  const until = Date.now() + RECOVERY_WAIT_MS
  while (!hasRoom() && Date.now() < until) await pause()
}

async function runDiagnoseCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'diagnose') return false
  const { diagnose } = await import('./diagnostics/diagnose.js')
  process.stdout.write(`${await diagnose()}\n`)
  return true
}

runServiceCommand(process.argv.slice(2))
  .then(async (handled) => handled || runRemoteCommand(process.argv.slice(2)))
  .then(async (handled) => handled || runDiagnoseCommand(process.argv.slice(2)))
  .then(async (handled) => handled || runUpgradeAgentsCommand(process.argv.slice(2)))
  .then(async (handled) => handled || runAgentCommand(process.argv.slice(2)))
  .then((handled) => { if (!handled) return main() })
  .catch((e) => { log(`cockpit host error: ${e.message}`); process.exit(1) })
