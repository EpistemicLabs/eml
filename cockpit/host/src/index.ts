#!/usr/bin/env node
// First: a host without a console sends its output to its log file from here on (log-file.ts).
import './log-file.js'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_TURN_HOOK_CONFIG, COCKPIT_HOME, DIAGNOSE_CLI_JS, SCHEDULE_CLI_JS, SESSION_DIRECTORY_CLI_JS, SESSION_MESSAGE_CLI_JS, MESSAGE_TOKEN_FILE, SESSION_TITLE_CLI_JS, SPAWN_CLI_JS, SPAWN_INBOX_DIR, TASKS_DIR } from './paths.js'
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
import { ChatBridge, IDLE_STOP } from './chat-bridge.js'
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
import { SpawnQueue } from './spawn-queue.js'
import { WorkerStarter } from './worker-start.js'
import { refreshServiceUnit, runServiceCommand } from './service.js'
import { SERVICE_ENV } from './domain/autostart.js'
import { idleMs, readLimits, sessionLimits } from './session-limits.js'
import { runRemoteCommand } from './remote.js'
import { runAgentCommand } from './agent-command.js'
import { scheduleUpdateChecks } from './app-update.js'
import { platform } from './infrastructure/platform/index.js'
import { JobStore } from './job-store.js'
import { JobRunner } from './application/job-runner.js'
import { Jobs, type JobAnswer, type JobCaller } from './application/jobs.js'
import { resolveProject } from './spawn-api.js'
import { ensureJobTokens } from './job-contract-api.js'
import { channelJobFacts, isChannelJob, withChannelTools } from './application/channel-job-launch.js'
import { lendJobTool, type JobSessions } from './application/lend-job-tool.js'
import { takeBackJobTools } from './application/take-back-job-tools.js'
import type { GrantTool, Job } from './domain/job.js'
import { bridgeServerFor, startChannelBridge } from './infrastructure/channel-bridge/channel-bridge.js'
import { bridgeFiles } from './channel-bridge-api.js'
import { createClaudeProvider } from './infrastructure/providers/claude/index.js'
import { createCodexProvider } from './infrastructure/providers/codex/index.js'
import { NotificationFeed, type Notifier } from './notifications.js'

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
  // A channel job's session gets the bridge's tools and its limits at every launch (channel-job-launch.ts).
  const channelJobOf = (sessionId: string) => {
    const jobId = ledger.get(sessionId)?.jobId
    const job = jobId ? jobStore.get(jobId) : undefined
    return job && isChannelJob(job) ? channelJobFacts(job, Date.now()) : null
  }
  const providers = new ProviderRegistry({
    providerOf: (sessionId) => ledger.get(sessionId)?.provider,
    preferred: readDefaultProvider,
    providers: [withChannelTools(createClaudeProvider(), { channelJobOf, bridgeServer: bridgeServerFor }), createCodexProvider()],
  })
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
  // Claude Code: the turn-hook config, the skills, .claude.json; for Codex:
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
    color: config?.mainColor,
    url: server.baseUrl,
    token: brain.token,
    turnHookConfig: CLAUDE_TURN_HOOK_CONFIG,
  })
  const spaces = new BrainSpaces(main)
  for (const extra of config?.spaces ?? []) {
    const extraRow = brainForLocalToken(extra.token)
    if (!extraRow) { log('space: a configured token matches no brain — skipped'); continue }
    spaces.add(openBrainSpace({
      id: extraRow.id, name: extra.name ?? extraRow.name, brainName: extraRow.name, main: false, color: extra.color,
      url: server.baseUrl, token: extra.token, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, agentId: extra.agent,
    }))
    const agent = spaces.get(extraRow.id)?.agent
    const problem = agent?.problem('claude')
    if (agent) log(`space ${extra.name ?? extraRow.name}: agent ${agent.id}${problem ? ` — ${problem}` : ''}`)
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
    // A greeted session names itself once it knows what it is about (session-greeting.ts).
    COCKPIT_TITLE_JS: SESSION_TITLE_CLI_JS,
    // A message that also reaches a stopped session (session-message-cli.ts).
    COCKPIT_MESSAGE_JS: SESSION_MESSAGE_CLI_JS,
    // Find a session by what the user calls it (session-directory-cli.ts).
    COCKPIT_SESSIONS_JS: SESSION_DIRECTORY_CLI_JS,
    // The schedule tool for sessions without it (schedule-cli.ts, skill schedule).
    COCKPIT_SCHEDULE_JS: SCHEDULE_CLI_JS,
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
      const agentOf = (id: string) => spaces.resolve(ledger.get(id)?.spaceId ?? null).agent?.id ?? null
      return ledger.get(fromSessionId) !== undefined && agentOf(fromSessionId) === agentOf(sessionId)
    },
    deliver: (sessionId, text) => chat.deliver(sessionId, text),
  }, request)
  watchSpawnInbox({ spawns, spawnToken, spaces, ledger, providers, deliver, jobs: { jobs: { handle: (caller, input) => jobs.handle(caller, input) }, callerOf: (id) => jobCaller(id) } })
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
    // The schedule tool (application/jobs.ts): its answer is the text the agent reads.
    jobs: async (sessionId: string, input: Record<string, unknown>): Promise<string> => {
      const caller = jobCaller(sessionId)
      if (!caller) return 'This session is not known to the cockpit, so it cannot schedule.'
      const answer: JobAnswer = await jobs.handle(caller, input)
      return answer.status >= 400 ? `Not done: ${answer.text}` : answer.text
    },
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
  // Jobs: work the cockpit wakes sessions for on a schedule (domain/job.ts, application/job-runner.ts).
  const jobStore = new JobStore()
  // What the user is told, under the bell; a push channel joins it here later (allOf).
  const feed = new NotificationFeed()
  const notifier: Notifier = feed
  const userTimeZone = () => jobStore.timeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const jobCaller = (sessionId: string): JobCaller | null => {
    const entry = ledger.get(sessionId)
    return entry ? { sessionId, spaceId: entry.spaceId ?? null, projectId: entry.projectId, toolProfile: entry.toolProfile } : null
  }
  // Tools lent to a job reach its sessions at their next start: stop them after the turn (lend-job-tool.ts).
  const sessionRuns = (sessionId: string) => chat.isRunning(sessionId) || bridge.isRunning(sessionId)
  const jobSessions: JobSessions = {
    sessionsOf: (jobId) => ledger.list().filter((entry) => entry.jobId === jobId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((entry) => entry.sessionId),
    runs: sessionRuns,
    turnOver: (sessionId) => new Promise<void>((resolve) => {
      const over = () => turns.get(sessionId)?.state !== 'working' || !sessionRuns(sessionId)
      if (over()) return resolve()
      const check = () => {
        if (!over()) return
        turns.off('turn', check)
        clearInterval(timer)
        resolve()
      }
      // The turn event is the signal; the look every few seconds covers a process that ended without one.
      const timer = setInterval(check, 5_000)
      timer.unref()
      turns.on('turn', check)
    }),
    stop: (sessionId) => chat.isRunning(sessionId) ? chat.end(sessionId, IDLE_STOP) : bridge.end(sessionId),
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }),
    timeZone: userTimeZone,
    log,
  }
  const onGrant = (job: Job, tool: GrantTool) => void lendJobTool(jobSessions, job, tool)
    .catch((err: unknown) => log(`[jobs] lending ${tool} to job ${job.id.slice(0, 8)} failed: ${(err as Error).message}`))
  const onGrantEnd = (job: Job, tools: GrantTool[]) => void takeBackJobTools(jobSessions, job, tools)
    .catch((err: unknown) => log(`[jobs] taking ${tools.join(', ')} back from job ${job.id.slice(0, 8)} failed: ${(err as Error).message}`))
  const jobRunner = new JobRunner({
    store: jobStore, log, timeZone: userTimeZone,
    hasRoom: (): boolean => startWorker.hasRoom(),
    sessionRuns,
    onGrantEnd,
    sessionState: (sessionId) => {
      if (!ledger.has(sessionId)) return 'queued'
      if (turns.get(sessionId)?.state === 'working') return 'working'
      return chat.isRunning(sessionId) || bridge.isRunning(sessionId) ? 'idle' : 'stopped'
    },
    statusSince: (sessionId, since) => {
      const entry = ledger.get(sessionId)
      const said = [entry?.attention, entry?.lastStatus].find((status) => status && status.at >= since)
      return said ? { kind: said.kind, reason: said.reason } : null
    },
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }),
    startWorker: (job, sessionId, text) => {
      if (job.target.type === 'session') return 'not a worker job'
      const parent = job.createdBy && ledger.has(job.createdBy) ? job.createdBy : null
      spawns.add({
        id: sessionId, projectId: job.target.projectId, prompt: text, title: job.name, fromSessionId: parent, origin: 'job', jobId: job.id,
        ...(job.target.provider ? { provider: job.target.provider } : {}),
        ...(job.toolProfile ? { toolProfile: job.toolProfile } : {}),
        ...(job.spaceId ? { spaceId: job.spaceId } : {}),
      })
      return null
    },
    notify: (input) => {
      log(`[jobs] tell: ${input.title}: ${input.body}`)
      notifier.notify(input)
    },
  })
  const jobs = new Jobs({
    store: jobStore, runner: jobRunner, defaultTimeZone: userTimeZone,
    resolveProject: (spaceId, input) => resolveProject(spaces.resolve(spaceId), input),
    findSession: (spaceId, target) => ledger.list(undefined, spaceId)
      .find((entry) => entry.sessionId === target || sessionAddress(entry.sessionId, entry.projectId) === target)?.sessionId ?? null,
    addressOf: (sessionId) => sessionAddress(sessionId, ledger.get(sessionId)?.projectId ?? null),
    projectName: (spaceId, projectId) => {
      const project = spaces.resolve(spaceId).registry.get(projectId)
      return project ? project.customName ?? project.displayName : projectId
    },
    providerKnown: (id) => providers.get(id) !== undefined,
    onGrant, onGrantEnd,
  })
  // The channel bridge's tokens, one per space (job-contract-api.ts); a space added later gets one at the next start.
  const jobSpaceIds = () => [spaces.main.id, ...spaces.list().filter((space) => !space.main).map((space) => space.id)]
  ensureJobTokens(jobSpaceIds())
  // The channel bridge, once there are mailboxes for it to watch (channel-bridge.ts).
  const channelBridge = await startChannelBridge(url, log)
  // Notification types that don't mean "waiting" — logged so new ones can be classified.
  turns.on('notification', (type: string) => { if (type !== 'idle_prompt') log(`[turn] notification ${type}`) })

  // Brain hygiene: the open space's banner offers a session (brain-hygiene.ts).
  const hygiene = new BrainHygiene({ spawns, log, isReady: () => providers.default().auth.signedIn() })

  const host = createHostServer(
    { spaces, bridge, chat, turns, providers, memoryUnavailable: memory.unavailable, hookToken, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, spawns, workers: startWorker, spawnToken, outsideToken: loadMessageToken(MESSAGE_TOKEN_FILE), deliver, hygiene,
      jobs: { jobs, store: jobStore, spawnToken, callerOf: jobCaller, feed, spaceName: (spaceId) => spaces.resolve(spaceId).name,
        sessionInfo: (sessionId) => {
          const entry = ledger.get(sessionId)
          return entry ? { projectId: entry.projectId, chat: entry.runtime === 'sdk' } : null
        },
      },
      channelBridge: bridgeFiles(),
      jobContract: { store: jobStore, spaceIds: jobSpaceIds, wake: (job, channel, text, key) => jobRunner.wake(job, channel, text, key) },
    },
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
  jobRunner.start()
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
      jobRunner.stop()
      channelBridge?.stop()
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
  .then(async (handled) => handled || runAgentCommand(process.argv.slice(2)))
  .then((handled) => { if (!handled) return main() })
  .catch((e) => { log(`cockpit host error: ${e.message}`); process.exit(1) })
