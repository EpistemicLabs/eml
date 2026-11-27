#!/usr/bin/env node
// First: a host without a console sends its output to its log file from here on (log-file.ts).
import './log-file.js'
import { timeLogLines } from './log-times.js'
import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { CLAUDE_TURN_HOOK_CONFIG, COCKPIT_HOME, DIAGNOSE_CLI_JS, SCHEDULE_CLI_JS, SESSION_DIRECTORY_CLI_JS, SESSION_MESSAGE_CLI_JS, MESSAGE_TOKEN_FILE, SESSION_TITLE_CLI_JS, SPAWN_CLI_JS, SPAWN_INBOX_DIR, TASKS_DIR } from './paths.js'
import { watchSpawnInbox } from './spawn-inbox.js'
import { fillHumanName, loadBrain } from './provision.js'
import { readCockpitConfig, writeCockpitConfig } from './config.js'
import { runFirstRunSetup } from './setup.js'
import { startOnboarding } from './onboarding.js'
import { BrainHygiene } from './brain-hygiene.js'
import { launchBrainServer } from './server-launch.js'
import { ProviderRegistry, defaultProviders } from './infrastructure/providers/registry.js'
import { SessionLedger } from './session-ledger.js'
import { readDefaultProvider } from './provider-settings.js'
import { ReportedModels } from './reported-models.js'
import { PtyBridge } from './pty-bridge.js'
import { mcpRelay, onSignInRefused, pluginStates, pluginStore, spacePlugins } from './plugins-api.js'
import { importBridgeAccounts, ownsBridgeAccounts, writeBridgeAccounts } from './infrastructure/plugins/bridge-accounts.js'
import { bridgeAccountsFor } from './domain/space-plugins.js'
import { readAgentMcpDefinitions, readAgentRuntime } from './agent-runtime.js'
import { writeCodexPluginServers } from './infrastructure/providers/codex/index.js'
import { readRemoteAccess } from './remote-access.js'
import { ChatBridge, IDLE_STOP, type TurnEndFacts } from './chat-bridge.js'
import { terminalBusyState } from './domain/session-lifecycle.js'
import { sessionsBlockRunner } from './domain/runner-busy.js'
import { createTaskLease } from './application/task-lease.js'
import { StartWorker, workerInChat } from './application/start-worker.js'
import { deliverMessage, type MessageRequest } from './application/deliver-message.js'
import { interruptedWorkers, recoverWorkers } from './application/recover-workers.js'
import { shutDownOnSignal } from './application/shut-down.js'
import type { SpawnRequest } from './domain/spawn-request.js'
import type { RuntimeEvent } from './domain/session-runtime.js'
import { loadMessageToken } from './message-token.js'
import { sessionAddress } from './session-address.js'
import { InMemoryEventStore } from './application/session-events.js'
import { SessionHandoff } from './application/session-handoff.js'
import { ABOUT, createHostServer, directoryEntries, type HostDeps } from './http.js'
import { getFreePort } from './ports.js'
import { TurnTracker, type TurnEvent } from './turn-state.js'
import { TimeTracker } from './time-tracking.js'
import { brainForLocalToken } from './brain-info.js'
import { BrainSpaces, openBrainSpace, sessionSpaceOf, type BrainSpace } from './brain-space.js'
import { HOOKS_PATH, MCP_PATH, boundAgent, createBrainMcpHandler, sessionClient } from './brain-mcp.js'
import { COCKPIT_MCP_PATH, COCKPIT_MCP_SERVER, createCockpitMcpHandler, notServed } from './cockpit-mcp.js'
import type { RecordEndTurnDeps } from './application/record-end-turn.js'
import { TerminalTurns, terminalTurnEnded } from './application/terminal-turns.js'
import { createSessionTask } from './application/session-task.js'
import { brainIdFromProjectId } from './project-registry.js'
import { createTaskRouter } from './application/task-router.js'
import { createTurnContexts, endTurnAccess } from './application/turn-context.js'
import { createTurnWake } from './application/turn-wake.js'
import { checkPrompt, resultOfTurn } from './domain/turn-end.js'
import { createTaskRunner, stepPrompt } from './application/task-runner.js'
import { createContinueSession } from './application/continue-session.js'
import { createWorkerTask, createWorkerTaskHolds, type WorkerTaskInput } from './application/worker-task.js'
import { createNextStepCheck } from './application/next-step.js'
import { createSessionKind } from './application/session-kind.js'
import { createCycles } from './application/cycles.js'
import { loadAgentBrains } from './agents.js'
import { upgradeAtStart } from './agent-upgrade.js'
import { runUpgradeAgentsCommand } from './agent-upgrade-cli.js'
import { runMigrateJobsCommand } from './job-migration-cli.js'
import { BACKUPS_DIR, CHANNEL_BRIDGE_ACCOUNTS_FILE, CHAT_MODELS_FILE, CONFIG_DIR, DATA_DIR, JOBS_MIGRATION_REPORT_FILE, PLUGINS_HOME } from './paths.js'
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
import { JobStore, jobsSetAsideNotice } from './job-store.js'
import { JobRunner, runProjectOf, type RunnerSpace, type RunnerTask } from './application/job-runner.js'
import { sessionsOnTask } from './domain/firing-order.js'
import { createTaskRecords } from './application/task-record.js'
import { editTaskSchedule } from './application/task-schedule-write.js'
import { Jobs, type JobAnswer, type JobCaller } from './application/jobs.js'
import { resolveProject } from './spawn-api.js'
import { ensureJobTokens, jobSpaceIdsOf } from './job-contract-api.js'
import { channelJobFacts, isChannelJob, withChannelTools } from './application/channel-job-launch.js'
import { lendJobTool, type JobSessions } from './application/lend-job-tool.js'
import { clearJobProfile } from './application/clear-job-profile.js'
import { takeBackJobTools } from './application/take-back-job-tools.js'
import { recordOfSession, sessionJobFacts } from './application/limited-job-scope.js'
import { repairSessionJobIds } from './application/session-job-repair.js'
import { sessionMessaging, type ProviderId } from './domain/agent-provider.js'
import { replyTool } from './domain/session-tools.js'
import { isHeld, scheduleFactsOf, type GrantTool, type Job } from './domain/job.js'
import type { ScheduleFacts } from './domain/task-schedule.js'
import { createJobMigration, membersOf } from './application/job-migration.js'
import { openTasks, taskById } from './application/task-read.js'
import { createMigrationWatch, pendingSpaces } from './application/job-migration-watch.js'
import { brainSchemaVersion } from './update-status.js'
import { endRunCount, endTaskRecord } from './application/end-task-record.js'
import { keepRecord } from './application/record-profile.js'
import { hasSchedule } from './domain/task-schedule.js'
import { bridgeServerFor, startChannelBridge } from './infrastructure/channel-bridge/channel-bridge.js'
import { bridgeFiles, renameBridgeJob } from './channel-bridge-api.js'
import { createClaudeProvider } from './infrastructure/providers/claude/index.js'
import type { Notifier } from './notifications.js'
import { PushStore } from './push-store.js'
import { PushNotifier, notifySessions } from './application/push-notifier.js'
import { routeUnrouted } from './application/unrouted-turns.js'
import { sessionFacts, withProject } from './application/session-facts.js'
import { sendPush, vapidSubject } from './infrastructure/push/web-push.js'
import { createTaskCommands, TaskCommandStore, type TaskCommands } from './application/task-commands.js'
import { createStartGate } from './application/start-gate.js'
import { createSplitSession } from './application/split-session.js'
import { createSplitBrief } from './application/split-brief.js'
import { createSortSession } from './application/sort-session.js'
import { claudeOneShot } from './infrastructure/providers/claude/one-shot.js'
import { HttpClient } from '@engramprotocol/mcp-server'
import { createTaskBoard } from './application/task-board.js'
import { createRunRecords, type RunRecords } from './application/run-records.js'
import { zoneLabel } from './domain/schedule.js'
import { createTaskStateMigration } from './application/task-state-migration.js'
import { liveFactsOf, runsBlockRunner, runsOf, type RunFacts } from './domain/runs.js'
import { parseHandoff } from './domain/handoff.js'
import { projectIdForBrain } from './project-registry.js'

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
  // Every line the host prints from here on starts with its time (log-times.ts).
  timeLogLines()
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
    const entry = ledger.get(sessionId)
    const job = entry ? recordOfSession(entry, jobStore) : undefined
    return job && isChannelJob(job) ? channelJobFacts(job, Date.now()) : null
  }
  const providers = new ProviderRegistry({
    providerOf: (sessionId) => ledger.get(sessionId)?.provider,
    preferred: readDefaultProvider,
    providers: defaultProviders(platform.os, withChannelTools(createClaudeProvider(), { channelJobOf, bridgeServer: bridgeServerFor })),
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
  // The brain MCP endpoint every session reaches its brains through, and the
  // hook routes the session hooks read from (brain-mcp.ts).
  const mcpUrl = `http://127.0.0.1:${hostPort}${MCP_PATH}`
  // The cockpit's own session tools for a session that runs in a terminal (cockpit-mcp.ts).
  const cockpitMcpUrl = `http://127.0.0.1:${hostPort}${COCKPIT_MCP_PATH}`
  const hooksUrl = `http://127.0.0.1:${hostPort}${HOOKS_PATH}`

  // Each agent CLI writes the files its sessions share across spaces (for
  // Claude Code: the turn-hook config, the skills, .claude.json; for Codex:
  // config.toml and hooks.json). A space's own files follow below.
  for (const provider of providers.all()) {
    provider.prepare({ hookUrl, hookToken, mcpUrl, cockpitMcpUrl, writableDirs: [SPAWN_INBOX_DIR, TASKS_DIR] })
  }
  log('isolation files written (CLAUDE_CONFIG_DIR, CODEX_HOME, QWEN_HOME)')

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
  // The plugins per space (application/space-plugins.ts): once per home the cockpit-wide switches
  // carry over and the MCP servers configured outside the plugins are imported; then every space
  // opens with the servers and the connector switches it has.
  const extraRows = (config?.spaces ?? []).flatMap((extra) => {
    const extraRow = brainForLocalToken(extra.token)
    return extraRow ? [{ id: extraRow.id, agent: extra.agent ?? null }] : []
  })
  const importSpaces = [{ id: row?.id ?? 'main', agent: config?.agent ?? null }, ...extraRows]
    .map((space) => ({ ...space, ownRuntime: agents.expectsRuntime(space.agent) }))
  const runtimeAgents = [...new Set(importSpaces.filter((space) => space.ownRuntime && space.agent).map((space) => space.agent as string))]
  try {
    const imported = await spacePlugins.setup(importSpaces, config?.plugins ?? {}, {
      claudeJson: path.join(CONFIG_DIR, '.claude.json'),
      agents: runtimeAgents.map((id) => {
        let allowed: string[] = []
        let definitions: Record<string, unknown> | null = null
        try { allowed = readAgentRuntime(id).mcpServers } catch { /* the runtime reports its own problem */ }
        try { definitions = readAgentMcpDefinitions(id) } catch { /* likewise */ }
        return { id, allowed, definitions }
      }),
    }, path.join(PLUGINS_HOME, 'backups'))
    const accounts = await importBridgeAccounts(CHANNEL_BRIDGE_ACCOUNTS_FILE, pluginStore, path.join(PLUGINS_HOME, 'backups'))
    if (accounts.imported.length > 0) log(`plugins: the channel bridge's accounts ${accounts.imported.join(', ')} became connections of their plugin`)
    if (accounts.problem) log(`plugins: ${accounts.problem}`)
    if (imported.imported.length > 0) log(`plugins: imported ${imported.imported.map((i) => i.serverName).join(', ')} as custom MCP plugins${imported.backup ? ` (backup ${imported.backup})` : ''}`)
    for (const skipped of imported.skipped) log(`plugins: ${skipped.serverName} not imported — ${skipped.reason}`)
    // Sign-ins stored before the relay served static secrets get a relay key: their secret leaves the spaces' mcp.json.
    const keyed = await spacePlugins.ensureRelayKeys()
    if (keyed.length > 0) log(`plugins: ${keyed.join(', ')} now reached through the relay`)
  } catch (err) {
    log(`plugins: setup failed — ${(err as Error).message}`)
  }
  const pluginSnapshot = await spacePlugins.snapshot().catch((err: Error) => { log(`plugins: ${err.message}`); return null })
  const pluginFiles = (spaceId: string) => {
    const files = pluginSnapshot?.filesFor(spaceId)
    for (const problem of files?.problems ?? []) log(`plugins: space ${spaceId} — ${problem}`)
    return files
  }
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
    plugins: pluginFiles(row?.id ?? 'main'),
  })
  const spaces = new BrainSpaces(main, config?.spaceOrder)
  for (const extra of config?.spaces ?? []) {
    const extraRow = brainForLocalToken(extra.token)
    if (!extraRow) { log('space: a configured token matches no brain — skipped'); continue }
    spaces.add(openBrainSpace({
      id: extraRow.id, name: extra.name ?? extraRow.name, agent: extra.agent ?? null, upgrade: upgradeStateOf(extraRow.id, extra.agent), main: false, color: extra.color,
      url: server.baseUrl, token: extra.token, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, mcpUrl, hooksUrl, ownRuntime: agents.expectsRuntime(extra.agent),
      plugins: pluginFiles(extraRow.id),
    }))
    const runtime = spaces.get(extraRow.id)?.runtime
    const problem = runtime?.problem('claude')
    if (runtime) log(`space ${extra.name ?? extraRow.name}: runtime of ${runtime.id}${problem ? ` — ${problem}` : ''}`)
  }
  // Codex reads one config for every space: each space's plugin servers are written there, off,
  // and its sessions switch on their own (codex/plugin-servers.ts).
  const writeCodexServers = async () => {
    const snapshot = await spacePlugins.snapshot()
    writeCodexPluginServers(Object.fromEntries(spaces.list().map((space) => [space.id, snapshot.filesFor(space.id).mcpServers])))
  }
  await writeCodexServers().catch((err: Error) => log(`plugins: Codex config — ${err.message}`))
  // Set once the channel bridge runs: a switch may change its accounts.
  let channelsChanged: () => void = () => {}
  // A switch changed later rewrites that space's session files (its next session starts with it).
  spacePlugins.onRewrite((spaceId, files) => {
    const space = spaces.get(spaceId)
    if (!space?.rewriteFiles) return false
    space.rewriteFiles(files)
    for (const problem of files.problems) log(`plugins: space ${space.name} — ${problem}`)
    void writeCodexServers().catch((err: Error) => log(`plugins: Codex config — ${err.message}`))
    channelsChanged()
    return true
  })
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
    canReceive: (sessionId) => sessionMessaging(providers.forSession(sessionId), ledger.get(sessionId)).supported,
    terminalRuns: (sessionId) => bridge.isRunning(sessionId),
    runsInChat: (sessionId) => providers.forSession(sessionId)
      .workerRunsInChat(sessionSpaceOf(spaces.resolve(ledger.get(sessionId)?.spaceId ?? null))),
    chatRuns: (sessionId) => chat.isRunning(sessionId),
    // A session that gets the cockpit's tools from its MCP server (Codex) answers with send_message from there.
    replyTool: (sessionId) => replyTool(providers.forSession(sessionId).capabilities.terminalTools.supported ? COCKPIT_MCP_SERVER : null),
    sameReach: (fromSessionId, sessionId) => {
      const agentOf = (id: string) => spaces.resolve(ledger.get(id)?.spaceId ?? null).agent
      return ledger.get(fromSessionId) !== undefined && agentOf(fromSessionId) === agentOf(sessionId)
    },
    deliver: (sessionId, text, opts) => chat.deliver(sessionId, text, opts),
  }, request)
  // The host's own message for a session (no sender), and whether the session has it now.
  const delivered = (sessionId: string, text: string, reminder = false) =>
    deliver({ target: sessionId, text, from: null, caller: 'session', ...(reminder ? { reminder: true } : {}) }).then((outcome) => outcome === 'delivered' || outcome === 'resumed')
  // Task system: every session works on a brain task (application/session-task.ts).
  const taskBrain = (space: BrainSpace) => {
    const agent = boundAgent({ agents }, space)
    return 'refused' in agent ? null : sessionClient(space, agent)
  }
  const owner = config?.handle ?? 'user'
  // Whether a session has the end_turn tool is its provider's to say (domain/agent-provider.ts): built in for a chat
  // session, from the cockpit MCP endpoint for a terminal session of a provider with terminalTools.
  const endTurnTool = (sessionId: string) => endTurnAccess(ledger.get(sessionId), providers.forSession(sessionId), COCKPIT_MCP_SERVER)
  // A task the cockpit creates for a spawned worker is the agent's alone; the runner is held off it until the worker is on it.
  const workerHolds = createWorkerTaskHolds(Date.now, () => spawns.list())
  const sessionTask = createSessionTask({
    ledger, spaces, brain: taskBrain, jobTask: (jobId) => jobStore.get(jobId)?.taskId ?? null, me: owner, endTurnTool,
    workerDelegate: (spaceId) => spaces.resolve(spaceId).agent ?? null, workerHolds, zone: () => zoneLabel(userTimeZone()),
  })
  // The router: whose turn it is after a session's turn, written into its task (application/task-router.ts).
  // Whom an end_turn call is read against: this member, the space's agent, its users and agents (application/turn-context.ts).
  const turnContexts = createTurnContexts({ ledger, spaces, brain: taskBrain, owner })
  const taskRouter = createTaskRouter({
    ledger, spaces, brain: taskBrain, owner, log,
    handles: (space) => turnContexts.handles(space),
    // A worker that closed its step leaves the lists; one the user started or pinned stays where they put it.
    finished: (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry?.worker || entry.pinned || entry.deskMain) return
      ledger.archive(sessionId)
    },
    routed: (sessionId, at) => ledger.clearUnrouted(sessionId, at),
  })
  // The task board's commands (application/task-commands.ts), made below; the runner asks them first.
  let taskCommands: TaskCommands | null = null
  // Set once the task commands exist; the chat and the hooks call it when the user writes.
  let userWrote: (sessionId: string) => void = () => {}
  // A brain project the cockpit has not opened yet gets its local entry and a cockpit-made folder.
  const ensureTaskProject = (space: BrainSpace, projectId: string): string | null => {
    const brainId = brainIdFromProjectId(projectId)
    if (!space.registry.get(projectId) && brainId) space.registry.ensureBrain(brainId, brainId)
    if (!space.registry.get(projectId)) return `project ${projectId} is not in space ${space.name}`
    if (!space.registry.get(projectId)!.path) space.registry.ensureCockpitFolder(projectId)
    return null
  }
  // The runner: the plan steps that are ready start in sessions of their own (application/task-runner.ts).
  // The owner's own idle session from before Delegate now does not hold it up (domain/runner-busy.ts).
  // The task board asks the same two checks, so it names the reason the runner skips a task.
  // A working run of a session this cockpit does not have holds it too: someone works on it elsewhere (domain/runs.ts).
  // A request still queued for the task holds it too (domain/task-lease.ts): the runner never queues a second one.
  const runnerBusy = (taskId: string, runs: readonly RunFacts[] = []) => {
    const own = ledger.list().filter((e) => e.taskId === taskId)
    return sessionsBlockRunner(
      own.map((e) => ({ createdAt: e.createdAt, archived: Boolean(e.archivedAt), working: turns.get(e.sessionId)?.state === 'working' })),
      taskCommands?.delegatedAt(taskId) ?? null,
      spawns.pendingFor(taskId) !== null,
    ) || runsBlockRunner(runs, new Set(own.map((e) => e.sessionId)), Date.now())
  }
  // An undoable hand-over, or Work on it now: the owner works with the agent, which never goes on alone.
  const lastResults = new Map<string, string>()
  // Set once the turns and the session runtimes exist; turnEnded pokes it.
  let runRecords: RunRecords = { sync: async () => {}, poke: () => {}, every: () => () => {} }
  const runnerHeld = (taskId: string, requestedAt?: string | null) =>
    Boolean(taskCommands?.held(taskId) || taskCommands?.together(taskId) || workerHolds.holds(taskId, requestedAt))
  // What holds one of the runner's slots: a session in a turn on the task, here or in another cockpit's run (domain/runs.ts).
  // The board also reads the commands each one still runs.
  const taskSessions = (taskId: string) => ledger.list().filter((e) => e.taskId === taskId && !e.archivedAt)
    .map((e) => ({ sessionId: e.sessionId, working: turns.get(e.sessionId)?.state === 'working', commands: turns.get(e.sessionId)?.commands ?? [] }))
  // The task's own open session (domain/own-session.ts): Delegate continues it, Take over opens it. Its context is read
  // from the provider's summary for that one session only.
  const contextTokensOf = (sessionId: string) => {
    const entry = ledger.get(sessionId)
    const projectPath = entry?.projectId ? spaces.resolve(entry.spaceId).registry.get(entry.projectId)?.path ?? null : null
    return providers.forSession(sessionId).summary(bridge.sessionRef(sessionId, projectPath)).contextTokens
  }
  const continueSession = createContinueSession({
    ledger,
    contextTokensOf,
    startFresh: (taskId) => taskCommands?.startFresh(taskId) ?? false,
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }),
    runStarted: () => runRecords.poke(),
    now: () => Date.now(),
  })
  // One live session per task (application/task-lease.ts): the fencing of queued requests, a split's holder, put-away.
  const taskLease = createTaskLease({
    pending: () => spawns.list(),
    sessions: () => ledger.list(),
    commands: () => taskCommands,
    working: (sessionId) => turns.get(sessionId)?.state === 'working',
    end: (sessionId, reason) => endAndPutAway(sessionId, reason),
    answered: (sessionId) => { void taskRouter.answered(sessionId) },
  })
  spawns.on('revoked', (id: string, why: string) => log(`[spawn] revoked ${id}: ${why}`))
  // Stop a session and put it away (a split undone, a task's session replaced by a new one).
  const endAndPutAway = async (sessionId: string, reason: string) => {
    bridge.killSession(sessionId)
    await chat.end(sessionId, reason)
    ledger.setTurnInFlight(sessionId, false)
    turns.forget(sessionId)
    sessionGone(sessionId)
    ledger.archive(sessionId)
  }
  const taskRunner = createTaskRunner({
    spaces, brain: taskBrain, me: owner, log,
    busy: runnerBusy,
    working: (taskId, runs) => liveFactsOf(taskSessions(taskId), runs, null, Date.now()).working,
    held: runnerHeld,
    scheduleFacts: (taskId) => scheduleFacts(taskId),
    brief: (taskId) => taskCommands?.briefOf(taskId),
    question: (taskId) => taskCommands?.questionOf(taskId),
    start: (space, step) => {
      const problem = ensureTaskProject(space, step.projectId)
      if (problem) return problem
      spawns.add({
        projectId: step.projectId, prompt: stepPrompt(step, step.checkpoint), title: step.title, fromSessionId: null,
        origin: 'runner', taskId: step.id, ...(space.main ? {} : { spaceId: space.id }),
      })
      return null
    },
    ownSession: (taskId) => continueSession.toContinue(taskId),
    continuedFor: (taskId, requestedAt) => continueSession.continuedFor(taskId, requestedAt),
    resume: (sessionId, step) => continueSession.resume(sessionId, step),
  })
  taskRunner.every(RUNNER_TICK_MS)
  // Agent session or the user's conversation, by the session's task as it stands now (application/session-kind.ts).
  const sessionKind = createSessionKind({ ledger, spaces, brain: taskBrain })
  // The next-step check: a delegated task always has a next trigger (application/next-step.ts).
  const nextStep = createNextStepCheck({
    ledger, spaces, brain: taskBrain, owner, log, endTurnTool,
    // The task's record here: its channels and a run waiting to start. Its next run is the task's schedule's, read with
    // the record's cursor and fired wake-up (next-step.ts).
    jobsOf: (taskId) => jobStore.list().filter((job) => job.taskId === taskId).map((job) => ({
      held: isHeld(job),
      channel: job.triggers.length > 0,
      runWaiting: jobStore.runs(job.id).some((run) => run.status === 'waiting'),
    })),
    scheduleFacts: (taskId) => scheduleFacts(taskId),
    runStartedAt: (sessionId) => {
      const entry = ledger.get(sessionId)
      const run = entry?.jobId ? jobStore.runs(entry.jobId).filter((r) => r.sessionId === sessionId && r.startedAt).at(-1) : undefined
      return run?.startedAt ?? entry?.createdAt ?? ''
    },
    working: (sessionId) => turns.get(sessionId)?.state === 'working',
    watched: (sessionId) => chat.sessionState(sessionId) === 'running' || bridge.sessionState(sessionId) === 'running',
    seen: (sessionId, since) => (ledger.get(sessionId)?.readAt ?? '') >= since,
    deliver: (sessionId, text) => delivered(sessionId, text, true),
    waiting: (sessionId) => flagged(sessionId),
    // Like a finished worker: one the user pinned or put on the desk stays.
    quiet: (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry?.worker || entry.pinned || entry.deskMain) return
      ledger.archive(sessionId)
    },
  })
  // Often enough that an answer left unseen is checked soon after its grace (UNSEEN_GRACE_MS); a tick without due sessions does nothing.
  setInterval(() => { void nextStep.tick() }, NEXT_STEP_TICK_MS).unref?.()
  // Weekly cycles (application/cycles.ts): the week's subject, and what the last cycle left carried over.
  const cycles = createCycles({ spaces, log, me: owner, brain: (space) => taskBrain(space) as ReturnType<typeof sessionClient> | null, timeZone: () => userTimeZone() })
  // A turn ended: whose turn it is goes into the task, and a step it finished may let the next one start.
  // `turn`: the end_turn call a chat session made and whether it was sent back already; a terminal's turn has neither.
  const turnEnded = (sessionId: string, text: string, turn?: TurnEndFacts) => {
    const endedAt = new Date().toISOString()
    // The run keeps the result of the session's last call or handoff (application/run-records.ts).
    const handoff = parseHandoff(text)
    const result = resultOfTurn(turn?.call, handoff)
    if (result) lastResults.set(sessionId, result)
    runRecords.poke()
    void taskRouter.turnEnded(sessionId, text, turn?.call, { unsaid: turn ? !turn.said : false, ctx: turn?.ctx })
      .then(() => nextStep.turnEnded(sessionId, { endedAt, reminded: turn?.reminded ?? false })).then(() => taskRunner.tick())
      .then(() => taskBoard.refresh()).catch((err) => log(`[task] after turn: ${(err as Error).message}`))
  }
  // What a terminal session said with end_turn, until its Stop hook ends the turn with it (application/terminal-turns.ts).
  const terminalTurns = new TerminalTurns()
  const terminalTurnDone = (sessionId: string, text: string) => terminalTurnEnded({ turns: terminalTurns, ledger, turnEnded }, sessionId, text)
  // A session's terminal process ended, or the session was stopped, archived or deleted: what it said in a turn
  // that never ended goes, and so do the MCP sessions its process held on the cockpit endpoint.
  const sessionGone = (sessionId: string) => {
    terminalTurns.forget(sessionId)
    void cockpitMcp.close(sessionId)
  }
  const sessionNamed = (sessionId: string, title: string) => {
    sessionTask.named(sessionId, title).catch((err) => log(`[task] naming the task of ${sessionId} failed: ${(err as Error).message}`))
  }
  // Sessions that had their name before their placeholder task: the task takes it now (once the brain answers).
  setTimeout(() => {
    for (const entry of ledger.list()) {
      const name = entry.title ?? entry.agentTitle
      if (entry.taskAuto && name) sessionNamed(entry.sessionId, name)
    }
  }, 15_000).unref?.()
  // The spawn API's newTask: the agent's alone, held off the runner until its worker is on it (application/worker-task.ts).
  const createTask = async (space: BrainSpace, input: WorkerTaskInput) => {
    const brain = taskBrain(space)
    if (!brain) return { error: `space ${space.name} has no agent` }
    return createWorkerTask({ brain, owner, agent: space.agent ?? null, holds: workerHolds }, input)
  }
  watchSpawnInbox({ spawns, spawnToken, spaces, ledger, providers, deliver, sessionNamed, createTask, stale: taskLease.stale, putAway: taskLease.putAway, contextTokensOf, jobs: { jobs: { handle: (caller, input) => scheduleTool.handle(caller, input) }, callerOf: (id) => jobCaller(id) } })
  // A conversation runs in one process, in the terminal or the chat view (session-handoff.ts).
  const handoff = (): SessionHandoff => sessionHandoff
  const bridge = new PtyBridge({
    ledger, providers, spaces, sessionEnv, handoff, chatHolds: (sessionId) => chat.isRunning(sessionId),
    memory, sessionLimits: () => sessionLimits(readLimits()),
    onProcessEnd: (sessionId) => sessionGone(sessionId),
    // The Shell plugin's terminal: while the plugin is on, on this machine, and remotely only after `eml-cockpit remote shell on`.
    shellRefusal: async (local) => {
      if (!(await pluginStates()).shell) return 'Shell is switched off (Settings › EML Plugins)'
      if (!local && !readRemoteAccess().shell) return 'The shell opens on this machine only (eml-cockpit remote shell on lets remote users open it)'
      return null
    },
  })
  // The cap on running sessions (Settings › Preferences › Sessions); 0: none.
  const running = (): number => chat.runningCount() + bridge.runningCount()
  const cap = () => readLimits().maxRunning
  const swept = bridge.sweepEmptySessions()
  if (swept > 0) process.stderr.write(`[pty] forgot ${swept} session(s) that never ran a turn\n`)
  const turns = new TurnTracker()
  // A session flagged for the user (a question, a failure) shows as a new result: its desk dot
  // clears once seen; the flag keeps it in Your turn (decision desk-dot-until-seen).
  const flagged = (sessionId: string) => { if (turns.get(sessionId)?.state !== 'working') turns.apply({ sessionId, state: 'done' }) }
  // The schedule tool (application/jobs.ts), for the session that calls it: its answer is the text the agent reads.
  const scheduleFor = async (sessionId: string, input: Record<string, unknown>): Promise<string> => {
    const caller = jobCaller(sessionId)
    if (!caller) return 'This session is not known to the cockpit, so it cannot schedule.'
    const answer: JobAnswer = await scheduleTool.handle(caller, input)
    return answer.status >= 400 ? `Not done: ${answer.text}` : answer.text
  }
  // When an end_turn call is read and the zone its next.when is read in.
  const callTime = () => ({ now: Date.now(), zone: userTimeZone() })
  // A call's next.when sets the wake-up of the session's task; a call without one clears it (application/turn-wake.ts).
  const settleTurnWake: NonNullable<RecordEndTurnDeps['turnWake']> = (sessionId, { edit, call, turn }) =>
    turnWake.settle(sessionId, { edit, why: checkPrompt(call, turn.ctx) })
  // The models each agent's last chat offered, for the launchers' picker (GET /api/providers/models).
  const reportedModels = new ReportedModels(CHAT_MODELS_FILE)
  const chat = new ChatBridge({
    ledger, providers, spaces, sessionEnv,
    events: new InMemoryEventStore(),
    onTurn: (sessionId, state, settleMs) => turns.apply({ sessionId, state, settleMs }),
    onHelpers: (sessionId, helpers, workflows) => turns.waitOn(sessionId, helpers, workflows),
    // A task says when a command of its session still runs: the board is built again.
    onCommands: (sessionId, commands) => {
      turns.commandsOn(sessionId, commands)
      if (ledger.get(sessionId)?.taskId) void taskBoard.refresh().catch(() => {})
    },
    turnDone: turnEnded,
    worksAlone: (sessionId) => sessionKind.worksAlone(sessionId),
    turnContext: (sessionId) => turnContexts.of(sessionId),
    callTime,
    turnWake: settleTurnWake,
    answered: (sessionId) => { void taskRouter.answered(sessionId) },
    userWrote: (sessionId) => userWrote(sessionId),
    handoffBeforeStop: (sessionId) => sessionTask.handoffBeforeStop(sessionId),
    onExit: (sessionId) => turns.forget(sessionId),
    memory,
    limits: () => {
      const settings = readLimits()
      return { session: sessionLimits(settings), idleMs: idleMs(settings) }
    },
    overCap: (): boolean => cap() > 0 && running() > cap(),
    jobOf: (sessionId) => {
      const entry = ledger.get(sessionId)
      const job = entry ? recordOfSession(entry, jobStore) : undefined
      // A record has no name of its own: its task's, as the engine last read it.
      return job ? { id: job.id, name: jobRunner.nameOf(job.id), limited: job.limited === true } : null
    },
    clearJobProfile: (jobId) => clearJobProfile(jobStore, jobId),
    jobs: scheduleFor,
    endTurnTool,
    modelsOffered: (provider, models) => reportedModels.remember(provider, models),
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
  // Turn state starts empty. A saved question or failure is not turned back into waiting: the desk dot
  // shows what is new until it is seen, the Inbox and Your turn hold what needs an answer, and only a
  // live prompt keeps a session waiting (decision desk-dot-until-seen).
  spawns.on('spawn', (request: SpawnRequest) => {
    if (request.fromSessionId) ledger.expectParent(request.id, request.fromSessionId)
    if (request.origin === 'split' || request.origin === 'task') ledger.expectOwn(request.id)
  })
  const startWorker = new StartWorker({
    chat, terminal: bridge, log,
    runsInChat: (request) => workerInChat(providers.get(request.provider ?? '') ?? providers.default(), sessionSpaceOf(spaces.resolve(request.spaceId ?? null)), request),
    freeMemory: () => platform.freeMemory(),
    atCap: () => cap() > 0 && running() >= cap(),
    makeRoom: () => chat.stopOneForRoom(),
  })
  // The local records of scheduled tasks and their runs (domain/job.ts, jobs.json version 2). A version 1 file
  // converted at this start keeps the spaces the cockpit has now: only those get the look for left-over schedules.
  const jobStore = new JobStore(undefined, spaces.list().map((space) => (space.main ? null : space.id)))
  // A ledger jobId names a record or a version 1 job that still waits; any other id is replaced at start by the
  // session's task id when it has one (application/session-job-repair.ts).
  const repaired = repairSessionJobIds(ledger, jobStore)
  if (repaired > 0) log(`[jobs] ${repaired} session(s) named a job that is neither a record nor a version 1 job that waits: they name their task now`)
  // What tells the user outside the cockpit: web push to every subscribed device (push-store.ts).
  const pushStore = new PushStore()
  const pushNotifier = new PushNotifier({
    devices: () => pushStore.devices(),
    send: (device, payload, options) => {
      const keys = pushStore.vapid()
      if (!keys) throw new Error('push key not stored')
      return sendPush(device, payload, keys, vapidSubject(device.origin), { ttlSeconds: 12 * 3600, ...options })
    },
    forget: (endpoint) => { pushStore.unsubscribe(endpoint) },
    log,
    now: () => Date.now(),
  })
  const notifier: Notifier = pushNotifier
  // A server that stops renewing a sign-in: the user hears it once, before a session needs it.
  onSignInRefused((connection) => pushNotifier.notify({
    kind: 'failed',
    title: `${connection.label} (${connection.plugin})`,
    body: 'The server refused to renew this sign-in. Sign in again in Settings › Plugins; sessions using it get no answer until then.',
    jobId: null,
    sessionId: null,
    spaceId: null,
  }))
  // Sign-ins running out soon are renewed ahead of use, also when no session reached them for days.
  const sweepRenewals = () => {
    void mcpRelay.renewDue().then((outcome) => {
      for (const [id, result] of Object.entries(outcome)) if (result !== 'renewed') log(`plugins: renewing ${id} — ${result}`)
    }).catch((err: Error) => log(`plugins: renewal sweep failed — ${err.message}`))
  }
  setInterval(sweepRenewals, 5 * 60_000).unref?.()
  sweepRenewals()
  const projectName = (spaceId: string | null, projectId: string | null) =>
    projectId ? spaces.resolve(spaceId).registry.get(projectId)?.displayName : undefined
  // Sessions tell what the review section shows: Needs you, Check this, a new result.
  notifySessions({ turns, notifier, facts: (sessionId) => sessionFacts({ ledger, turns, projectName }, sessionId) })
  const userTimeZone = () => jobStore.timeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const jobCaller = (sessionId: string): JobCaller | null => {
    const entry = ledger.get(sessionId)
    if (!entry) return null
    // A limited task's session reaches only its own task's schedule; one whose record is gone counts as limited (limited-job-scope.ts).
    const facts = sessionJobFacts(entry.jobId ?? null, recordOfSession(entry, jobStore))
    // Target self means the task the session works on.
    return { sessionId, spaceId: entry.spaceId ?? null, projectId: entry.projectId, toolProfile: entry.toolProfile, taskId: entry.taskId, ...facts }
  }
  // Tools lent to a job reach its sessions at their next start: stop them after the turn (lend-job-tool.ts).
  const sessionRuns = (sessionId: string) => chat.isRunning(sessionId) || bridge.isRunning(sessionId)
  const jobSessions: JobSessions = {
    sessionsOf: (jobId) => ledger.list().filter((entry) => recordOfSession(entry, jobStore)?.id === jobId)
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
  const onGrant = (job: Pick<Job, 'id' | 'grants'>, tool: GrantTool) => void lendJobTool(jobSessions, job, tool)
    .catch((err: unknown) => log(`[jobs] lending ${tool} to job ${job.id.slice(0, 8)} failed: ${(err as Error).message}`))
  const onGrantEnd = (job: Pick<Job, 'id'>, tools: GrantTool[]) => void takeBackJobTools(jobSessions, job, tools)
    .catch((err: unknown) => log(`[jobs] taking ${tools.join(', ')} back from job ${job.id.slice(0, 8)} failed: ${(err as Error).message}`))
  // What this cockpit's record says of a task's schedule: for the task runner's hold, the next-step check and the board.
  const scheduleFacts = (taskId: string): ScheduleFacts => scheduleFactsOf(jobStore.get(taskId), jobStore.runs(taskId))
  // The engine: it fires the schedules of the tasks this member owns (application/job-runner.ts).
  // Whether a space is shared: what the host knows, else the brain server asked again (team-space.ts); null: still unknown.
  const spaceKindOf = async (space: BrainSpace): Promise<boolean | null> => {
    if (space.shared === null) await loadSharedFlags([space])
    return space.shared
  }
  const runnerSpaceOf = (space: BrainSpace): RunnerSpace => ({ key: space.main ? null : space.id, name: space.name, shared: space.shared })
  const brainOfRunnerSpace = (space: RunnerSpace) => taskBrain(spaces.resolve(space.key))
  /** When the engine last asked the jobs migration to look through a space it holds (holdsFirstSight below). */
  let lookAskedAt = 0
  const LOOK_ASK_MS = 5 * 60_000
  const jobRunner: JobRunner = new JobRunner({
    store: jobStore, log, timeZone: userTimeZone, me: owner,
    spaces: () => spaces.list().map(runnerSpaceOf),
    // A space the brain server said nothing of at boot is asked about again; until it answers nothing fires there.
    spaceKind: (space) => spaceKindOf(spaces.resolve(space.key)),
    members: async (space) => { const brain = brainOfRunnerSpace(space); return brain ? membersOf(brain) : null },
    // The space's open tasks, as the task runner lists them: two reads per space, none per task.
    openTasks: async (space) => {
      const brain = brainOfRunnerSpace(space)
      if (!brain) return null
      return openTasks<RunnerTask>(brain)
    },
    // A task's version 1 jobs move onto it first: the migration replaces its schedule with what its jobs say.
    waitsForMigration: (taskId) => jobStore.hasV1Jobs(taskId),
    migratingTasks: () => jobStore.v1TaskIds(),
    // In a home that was on version 1, until the migration has looked through a space the cockpit had at the
    // conversion for left-over schedules, none is taken up there by being seen. Each such space has its own look: one
    // an agent is bound to after the start's passes asks for a pass of the migration here (at most every few
    // minutes), so it is not held until the next start. A space added after the conversion is never held.
    holdsFirstSight: (space) => {
      const holds = jobStore.awaitsLeftoverLook(space.key)
      if (holds && Date.now() - lookAskedAt >= LOOK_ASK_MS) {
        lookAskedAt = Date.now()
        void jobMigration.run().catch((err: unknown) => log(`[jobs] migration failed: ${(err as Error).message}`))
      }
      return holds
    },
    task: async (space, taskId) => {
      const brain = brainOfRunnerSpace(space)
      if (!brain) throw new Error('its space has no agent')
      return taskById<RunnerTask>(brain, taskId)
    },
    // Another member's session works on it: only a shared space has one (domain/runs.ts).
    workingElsewhere: async (space, taskId) => {
      if (space.shared === false) return false
      const brain = brainOfRunnerSpace(space)
      if (!brain) return false
      const runs = runsOf(((await brain.get('/object/run')) as { objects?: Array<Record<string, unknown>> }).objects ?? []).filter((run) => run.task_id === taskId)
      return runsBlockRunner(runs, new Set(ledger.list().filter((e) => e.taskId === taskId).map((e) => e.sessionId)), Date.now())
    },
    // Linked: started for the task's record, so each of its launches gets the bridge's tools (withChannelTools).
    sessionsOf: (taskId) => sessionsOnTask(ledger.list(), taskId, (sessionId) => turns.get(sessionId)?.state === 'working'),
    editSchedule: async (space, taskId, edit, text) => {
      const brain = brainOfRunnerSpace(space)
      if (!brain) throw new Error('its space has no agent')
      await editTaskSchedule(brain, taskId, edit, { agent: spaces.resolve(space.key).agent, ...(text ? { text } : {}) })
      void taskBoard.refresh().catch(() => {})
    },
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
    // A new session of the task: in the record's project, else the task's own, with the record's limits. It is linked
    // to the task and to the record (the ledger's jobId is the record's id), so limits, grants and run records hold.
    projectOf: (record, task) => runProjectOf(record, task),
    startWorker: (record, task, sessionId, text) => {
      const space = spaces.resolve(record.spaceId)
      const projectId = runProjectOf(record, task)
      if (!projectId) return 'the task has no project to run in'
      const problem = ensureTaskProject(space, projectId)
      if (problem) return problem
      const parent = record.createdBy && ledger.has(record.createdBy) ? record.createdBy : null
      spawns.add({
        id: sessionId, projectId, prompt: text, title: jobRunner.nameOf(record.id).slice(0, 60), fromSessionId: parent, origin: 'job', jobId: record.id, taskId: record.taskId,
        ...(record.provider ? { provider: record.provider } : {}),
        ...(record.toolProfile ? { toolProfile: record.toolProfile } : {}),
        ...(record.spaceId ? { spaceId: record.spaceId } : {}),
      })
      return null
    },
    notify: (input) => {
      log(`[jobs] tell: task=${input.jobId?.slice(0, 8) ?? '-'} kind=${input.kind}`)
      notifier.notify(withProject({ ledger, projectName }, input))
    },
    // In the review section, as "Needs you": the task's newest run session, else whoever set the record up.
    flag: (record, text) => {
      const own = jobSessions.sessionsOf(record.id)[0]
      const sessionId = [own, record.createdBy].find((id): id is string => !!id && ledger.has(id))
      if (!sessionId) return
      ledger.setAttention(sessionId, { kind: 'failed', reason: text.slice(0, 300) })
      flagged(sessionId)
    },
  })
  // The user's per-machine settings of a scheduled task, on its record (application/task-record.ts).
  const taskRecords = createTaskRecords({
    store: jobStore, now: () => Date.now(),
    spaceKey: (spaceId) => { const space = spaces.get(spaceId); return space ? (space.main ? null : space.id) : undefined },
    taskStatus: async (spaceId, taskId) => {
      const space = spaces.get(spaceId)
      const brain = space ? taskBrain(space) : null
      if (!brain) throw new Error('its space has no brain to ask')
      return (await taskById<{ status?: string }>(brain, taskId))?.status ?? null
    },
    held: (record) => jobRunner.held(record),
    sessionInfo: (sessionId) => {
      const entry = ledger.get(sessionId)
      return entry ? { projectId: entry.projectId, chat: entry.runtime === 'sdk', attention: entry.attention?.kind ?? null } : null
    },
    onGrant, onGrantEnd,
  })
  // The schedule tool (application/jobs.ts): a session's tool, its CLI, the spawn inbox and POST /api/jobs all end here.
  const scheduleTool = new Jobs({
    store: jobStore, me: owner, defaultTimeZone: userTimeZone,
    brain: (spaceId) => taskBrain(spaces.resolve(spaceId)),
    agent: (spaceId) => spaces.resolve(spaceId).agent ?? null,
    engine: {
      runNow: (spaceId, task) => jobRunner.runNow(runnerSpaceOf(spaces.resolve(spaceId)), task as RunnerTask),
      paused: (taskId) => jobRunner.paused(taskId),
      resumed: (taskId) => jobRunner.resumed(taskId),
    },
    // A task's version 1 jobs move onto it first: the migration replaces its schedule with what its jobs say.
    moving: (taskId) => jobStore.hasV1Jobs(taskId),
    resolveProject: (spaceId, input) => resolveProject(spaces.resolve(spaceId), input),
    projectName: (spaceId, projectId) => {
      const project = spaces.resolve(spaceId).registry.get(projectId)
      return project ? project.customName ?? project.displayName : projectId
    },
    providerKnown: (id): id is ProviderId => providers.get(id) !== undefined,
    // The main space is local by construction; any other counts as shared until the brain server said otherwise.
    sharedSpace: (spaceId) => {
      const space = spaces.resolve(spaceId)
      return !space.main && space.shared !== false
    },
    onGrantEnd,
    changed: () => { void taskBoard.refresh().catch(() => {}) },
  })
  const turnWake = createTurnWake({
    where: (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry) return null
      const space = spaces.resolve(entry.spaceId ?? null)
      return { taskId: entry.taskId ?? null, brain: taskBrain(space), agent: space.agent ?? null, spaceId: entry.spaceId ?? null, toolProfile: entry.toolProfile }
    },
    records: jobStore,
    moving: (taskId) => jobStore.hasV1Jobs(taskId),
    scheduleFacts,
    zone: userTimeZone, log,
    changed: () => { void taskBoard.refresh().catch(() => {}) },
  })
  // jobs.json version 1 → 2: the jobs of before brain schema 24 move onto their tasks (application/job-migration.ts).
  const jobMigration = createJobMigration({
    store: jobStore, spaces: () => spaces.list(), brain: taskBrain, me: owner, now: () => Date.now(), log,
    spaceKind: spaceKindOf,
    // As the brain server's control data has it: a brain that is not at schema 24 yet is not planned.
    brainSchema: (space) => { try { return brainSchemaVersion(space.id) } catch { return null } },
    // The channel bridge files its messages, wakes and drafts by job id: it follows a moved job's new id.
    renameInBridge: (from, to) => renameBridgeJob(bridgeFiles(), from, to),
    // Each real run's report is kept, appended to one file in the home; the user is told when a job did not move.
    saveReport: (markdown) => {
      fs.appendFileSync(JOBS_MIGRATION_REPORT_FILE, `${markdown}\n`, { mode: 0o600 })
      return JOBS_MIGRATION_REPORT_FILE
    },
    notify: (input) => notifier.notify(input),
    moveSessions: (from, to) => { for (const entry of ledger.list()) if (entry.jobId === from) ledger.setJobId(entry.sessionId, to) },
  })
  // The channel bridge's tokens, one per local space (job-contract-api.ts); a space added later gets one at the next start.
  const jobSpaceIds = () => jobSpaceIdsOf(spaces.list())
  ensureJobTokens(jobSpaceIds())
  // The channel bridge, once there are mailboxes for it to watch (channel-bridge.ts).
  // The bridge's accounts follow the channel plugins' switches and connections (no home space: one
  // account per connection, on in every space that picked it); the bridge reads them at start.
  const writeAccounts = async (): Promise<boolean> => {
    // A hand-written file the import could not take over is left as it is.
    if (!(await ownsBridgeAccounts(pluginStore))) return false
    const snapshot = await spacePlugins.snapshot()
    const { accounts, problems } = bridgeAccountsFor(snapshot.state, snapshot.manifests, await pluginStore.connections(), jobSpaceIds())
    for (const problem of problems) log(`plugins: ${problem}`)
    return writeBridgeAccounts(CHANNEL_BRIDGE_ACCOUNTS_FILE, accounts)
  }
  await writeAccounts().catch((err: Error) => log(`plugins: bridge accounts — ${err.message}`))
  let channelBridge = await startChannelBridge(url, log)
  let bridgeRestart: Promise<unknown> = Promise.resolve()
  channelsChanged = () => {
    bridgeRestart = bridgeRestart.then(async () => {
      if (!(await writeAccounts())) return
      channelBridge?.stop()
      channelBridge = await startChannelBridge(url, log)
      log('[bridge] restarted with its new accounts')
      // A bridge that was off when jobs moved onto their tasks is told their new ids now.
      await jobMigration.confirmRenames()
    }).catch((err: Error) => log(`plugins: bridge accounts — ${err.message}`))
  }
  // Notification types that don't mean "waiting" — logged so new ones can be classified.
  turns.on('notification', (type: string) => { if (type !== 'idle_prompt') log(`[turn] notification ${type}`) })
  // The Time plugin's clocks: the agent's from the turns, the user's from the browser's beats.
  const time = new TimeTracker((sessionId) => {
    const entry = ledger.get(sessionId)
    return entry ? { spaceId: entry.spaceId, projectId: entry.projectId, taskId: entry.taskId } : null
  }, async () => (await pluginStates()).time)
  turns.on('turn', (event: TurnEvent) => { void time.turn(event) })

  // Brain hygiene: the open space's banner offers a session (brain-hygiene.ts).
  const hygiene = new BrainHygiene({ spawns, log, isReady: () => providers.default().auth.signedIn() })

  // Synced run records: one per session on a task, written when something happens in it (application/run-records.ts).
  runRecords = createRunRecords({
    spaces: () => spaces.list(),
    brain: taskBrain,
    me: owner,
    sessions: () => ledger.list().map((e) => ({
      sessionId: e.sessionId, taskId: e.taskId, spaceId: spaces.resolve(e.spaceId ?? null).id, createdAt: e.createdAt,
      archived: Boolean(e.archivedAt), jobId: e.jobId, worker: e.worker, parentSessionId: e.parentSessionId, runStartedAt: e.runStartedAt,
    })),
    turnOf: (sessionId) => turns.get(sessionId)?.state,
    processRuns: (sessionId) => chat.isRunning(sessionId) || bridge.isRunning(sessionId),
    resultOf: (sessionId) => lastResults.get(sessionId) ?? null,
    agentOf: (space) => space.agent,
    log,
  })
  turns.on('turn', () => runRecords.poke())
  // The first sync waits for sessions a restart brings back, so their runs are not ended as crashed first.
  setTimeout(() => { void runRecords.sync() }, RUN_FIRST_SYNC_MS).unref?.()
  runRecords.every(RUN_SYNC_MS)

  // The task board (application/task-board.ts) and its commands with Undo (application/task-commands.ts).
  const taskBoard = createTaskBoard({
    spaces: () => spaces.list(),
    brain: taskBrain,
    viewer: owner,
    sessionsOn: taskSessions,
    snoozes: () => taskCommands?.snoozes() ?? [],
    pendingCommands: () => taskCommands?.pending() ?? [],
    releasedAgent: (taskId) => taskCommands?.releasedAgent(taskId) ?? null,
    ownSessionOf: (taskId) => continueSession.boardView(taskId),
    reopenedWith: (taskId) => taskCommands?.reopenedWith(taskId) ?? [],
    ledgerSessionsOn: (taskId) => ledger.list().filter((e) => e.taskId === taskId).map((e) => e.sessionId),
    runnerBusy, runnerHeld,
    scheduleFacts: (taskId) => scheduleFacts(taskId),
    runnerStartedAt: (taskId) => taskRunner.startedAt(taskId),
    now: () => Date.now(),
    log,
    // The space's log head, straight from its brain (brain GET /head): what the board watches to refresh live.
    head: async (space, after, waitMs) => {
      const brain = new HttpClient({ url: space.url, token: space.token, timeoutMs: waitMs + 10_000 })
      const answer = await brain.get('/head', { ...(after !== null ? { after } : {}), wait: waitMs }) as { seq: number }
      return answer.seq
    },
  })
  const taskCommandStore = new TaskCommandStore()
  // The task state migration of a space: a dry run its owner sees first, then the run (application/task-state-migration.ts).
  const taskStateMigration = createTaskStateMigration({
    space: (spaceId) => spaces.get(spaceId), brain: taskBrain, viewer: owner,
    snoozes: () => taskCommandStore.snoozes(Date.now()),
    setSnoozes: (snoozes) => taskCommandStore.setSnoozes(snoozes),
    heldWaitsFile: path.join(COCKPIT_HOME, 'held-waits.json'),
    liveSessions: (spaceId) => ledger.list()
      .filter((e) => e.taskId && !e.archivedAt && spaces.resolve(e.spaceId ?? null).id === spaceId && (chat.isRunning(e.sessionId) || bridge.isRunning(e.sessionId)))
      .map((e) => ({ sessionId: e.sessionId, taskId: e.taskId! })),
    now: () => Date.now(),
    log,
  })
  taskCommands = createTaskCommands({
    store: taskCommandStore,
    viewer: owner,
    space: (spaceId) => spaces.get(spaceId),
    brain: taskBrain,
    agentsOf: async (space) => {
      const found = await taskBrain(space)?.get('/object/agent').catch(() => null) as { objects?: Array<{ id: string }> } | null
      return (found?.objects ?? []).map((a) => a.id)
    },
    ownSession: (taskId) => continueSession.ownSession(taskId)?.sessionId ?? null,
    sessionOpen: (sessionId) => { const entry = ledger.get(sessionId); return Boolean(entry && !entry.archivedAt) },
    sessionsSince: (taskId, since) => {
      const on = ledger.list().filter((e) => e.taskId === taskId && Date.parse(e.createdAt) >= Date.parse(since))
      return { total: on.length, open: on.filter((e) => !e.archivedAt).length }
    },
    // Send in a closed task's chat: the message goes to its newest session, or starts one when it has none.
    newestSessionOn: (taskId) => ledger.list().filter((e) => e.taskId === taskId)
      .sort((a, b) => Date.parse(b.lastAttached ?? b.createdAt) - Date.parse(a.lastAttached ?? a.createdAt))[0]?.sessionId ?? null,
    deliver: (sessionId, text) => delivered(sessionId, text),
    supersedeRunner: (taskId) => { spawns.revokeRunnerFor(taskId, 'the owner works on the task now') },
    startOnTask: async (spaceId, taskId, prompt) => {
      const started = await startOnTask({ spaceId, taskId, prompt })
      return started.ok ? started.sessionId : null
    },
    // End schedule: the task's record here ends with its schedule (application/end-task-record.ts).
    endRecord: (_spaceId, taskId) => endTaskRecord(jobStore, taskId, Date.now(), onGrantEnd),
    // A scheduled hand-over is an explicit act here: this cockpit keeps the task's record from now on.
    keepRecord: (spaceId, taskId) => {
      const space = spaces.get(spaceId)
      if (space) keepRecord(jobStore, { id: taskId, spaceId: space.main ? null : space.id }, new Date().toISOString())
    },
    // The schedule's controls on the task: Run now goes through the engine, Pause and Resume tell it at once.
    schedule: {
      runNow: async (spaceId, task) => {
        const space = spaces.get(spaceId)
        if (!space) return 'unknown_space'
        const result = await jobRunner.runNow(runnerSpaceOf(space), task as RunnerTask)
        return typeof result === 'string' ? result : ('started' as const)
      },
      listens: (taskId) => (jobStore.get(taskId)?.triggers.length ?? 0) > 0,
      heldAfterFailures: (taskId) => (jobStore.get(taskId)?.pausedReason ?? null) !== null,
      paused: (taskId) => jobRunner.paused(taskId),
      resumed: (taskId) => jobRunner.resumed(taskId),
      cronsEnded: (taskId) => endRunCount(jobStore, taskId, Date.now()),
    },
    changed: () => { void taskBoard.refresh().catch(() => {}) },
    now: () => Date.now(),
    log,
  })
  // The user wrote in a session on a closed task (a desk, outside the board): the task reopens first.
  userWrote = (sessionId) => {
    const entry = ledger.get(sessionId)
    if (!entry?.taskId) return
    void taskCommands?.reopenByWriting(spaces.resolve(entry.spaceId).id, entry.taskId)
  }
  // A session of the user's own on a task, started from the page (a task row, Advance task): the host binds the
  // task and queues it; the page claims it and opens it in chat when that is the user's view (application/start-worker.ts).
  type StartInput = { spaceId: string; taskId: string; projectId?: string; prompt?: string; title?: string; deskId?: string }
  // One start per task and prompt at a time (application/start-gate.ts): several clients asking at once get one session.
  const startGate = createStartGate<Awaited<ReturnType<typeof startOnTaskOnce>>>()
  const startOnTask = (input: StartInput) => startGate(`${input.spaceId}:${input.taskId}:${input.prompt ?? ''}`, () => startOnTaskOnce(input))
  const startOnTaskOnce = async (input: StartInput) => {
    const space = spaces.get(input.spaceId)
    if (!space) return { ok: false as const, refusal: 'unknown_space' as const }
    const task = await taskBrain(space)?.get(`/engram/${encodeURIComponent(input.taskId)}`).catch(() => null) as { title?: string | null; status?: string; scope?: string } | null | undefined
    if (!task) return { ok: false as const, refusal: 'unknown_task' as const }
    if (task.status !== 'planned' && task.status !== 'active') return { ok: false as const, refusal: 'task_closed' as const }
    const brainProject = task.scope?.startsWith('project.') ? task.scope.slice('project.'.length) : null
    const projectId = input.projectId ?? (brainProject ? projectIdForBrain(brainProject) : null)
    if (!projectId) return { ok: false as const, refusal: 'no_project' as const }
    const problem = ensureTaskProject(space, projectId)
    if (problem) return { ok: false as const, refusal: 'no_project' as const, message: problem }
    const title = input.title ?? task.title ?? input.taskId
    const request = spawns.add({
      projectId, title: title.slice(0, 60), fromSessionId: null, open: true, origin: 'task', taskId: input.taskId,
      prompt: input.prompt ?? `Work on task ${input.taskId} ("${title}") together with the user, who owns it. Start by saying where it stands and what you would do next.`,
      ...(input.deskId ? { deskId: input.deskId } : {}),
      ...(space.main ? {} : { spaceId: space.id }),
    })
    return { ok: true as const, sessionId: request.id }
  }
  // What a split or a sort reads about a session.
  const splitSessionFacts = (sessionId: string) => {
    const entry = ledger.get(sessionId)
    return entry ? { spaceId: entry.spaceId, title: entry.title ?? entry.agentTitle ?? sessionId, taskId: entry.taskId } : null
  }
  // Sorting a drifted session (application/sort-session.ts).
  const sortSession = createSortSession({
    store: taskCommandStore,
    session: splitSessionFacts,
    space: (spaceId) => spaces.resolve(spaceId),
    brain: taskBrain,
    changed: () => { void taskBoard.refresh().catch(() => {}) },
    now: () => Date.now(),
    log,
    me: owner,
    scheduled: hasSchedule,
  })
  // The brief of a split the user starts: one short model call under the session's space (application/split-brief.ts).
  const claudeConfigOf = (spaceId: string | null) => {
    const space = spaces.resolve(spaceId)
    return space.runtime ? space.runtime.configDirs.claude ?? null : CONFIG_DIR
  }
  // The space's open tasks, for splitting onto one instead of making another.
  const openTasksOf = async (space: BrainSpace) => {
    const brain = taskBrain(space)
    if (!brain) return []
    const lists = await Promise.all(['planned', 'active'].map((status) => brain.get('/list', { type: 'task', status, limit: 200 }).catch(() => ({ engrams: [] }))))
    return lists.flatMap((l) => ((l as { engrams?: Array<{ id: string; title: string | null; scope: string }> }).engrams ?? []))
      .map((t) => ({ id: t.id, title: t.title ?? t.id, project: t.scope.startsWith('project.') ? t.scope.slice('project.'.length) : null }))
  }
  // A session's earlier conversation, read through its provider's chat runtime: only a provider with a chat
  // has one there. Null when it has none, or it could not be read.
  const earlierConversation = async (sessionId: string): Promise<RuntimeEvent[] | null> => {
    const entry = ledger.get(sessionId)
    const provider = entry ? providers.get(entry.provider) : undefined
    if (!entry || !provider?.capabilities.chat.supported || !provider.chatRuntime || !entry.projectId) return null
    const space = spaces.resolve(entry.spaceId)
    const projectPath = space.registry.get(entry.projectId)?.path
    if (!projectPath) return null
    return provider.chatRuntime.history(ledger.ref(sessionId, projectPath, space.runtime)).catch(() => null)
  }
  const splitBrief = createSplitBrief({
    transcript: earlierConversation,
    facts: async (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry) return null
      const space = spaces.resolve(entry.spaceId)
      const task = entry.taskId
        ? await taskBrain(space)?.get(`/engram/${entry.taskId}`).catch(() => null) as { title?: string } | null | undefined
        : null
      return {
        sessionTitle: entry.title ?? entry.agentTitle ?? sessionId,
        taskTitle: task?.title ?? null,
        projects: space.registry.list().filter((p) => !p.hidden).map((p) => ({ id: p.projectId, name: p.displayName, brainProjectId: p.brainProjectId })),
        openTasks: await openTasksOf(space),
        hasTask: entry.taskId !== null,
      }
    },
    complete: async (sessionId, prompt) => {
      const configDir = claudeConfigOf(ledger.get(sessionId)?.spaceId ?? null)
      if (!configDir) throw new Error('this space has no Claude Code sign-in')
      return claudeOneShot(configDir, prompt)
    },
    today: () => new Date().toISOString().slice(0, 10),
  })
  taskCommands.every(TASK_COMMAND_TICK_MS)
  taskBoard.every(TASK_BOARD_REFRESH_MS, TASK_BOARD_VIEWED_MS)
  taskBoard.watch({ viewedMs: TASK_BOARD_VIEWED_MS })

  // Split off a topic from a session (application/split-session.ts); its commands share the task commands' file.
  const splitSession = createSplitSession({
    store: taskCommandStore,
    session: splitSessionFacts,
    space: (spaceId) => spaces.resolve(spaceId),
    brain: taskBrain,
    brainProject: (space, projectId) => {
      const project = space.registry.get(projectId)
      return project ? project.brainProjectId : (brainIdFromProjectId(projectId) ?? undefined)
    },
    spawn: ({ fromSessionId, projectId, title, prompt, taskId, space }) => spawns.add({
      projectId, prompt, title: title.slice(0, 60), fromSessionId, open: true, origin: 'split',
      ...(taskId ? { taskId } : {}),
      ...(space.main ? {} : { spaceId: space.id }),
    }).id,
    endSession: (sessionId) => endAndPutAway(sessionId, 'split undone'),
    // Onto a task that has its session: the brief goes there (application/task-lease.ts).
    holderOf: (taskId) => taskLease.splitHolder(taskId),
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }),
    changed: () => { void taskBoard.refresh().catch(() => {}) },
    now: () => Date.now(),
    log,
    me: owner,
  })

  const brainMcp = createBrainMcpHandler({ spaces, agents, ledger, providers, serverVersion: ABOUT.version })
  // The cockpit's own session tools for terminal sessions (cockpit-mcp.ts). Which providers' terminal sessions it
  // serves is theirs to say (capability terminalTools): the others are refused with the provider's reason.
  const cockpitMcp = createCockpitMcpHandler({
    spaces, ledger, terminalTurns,
    chatTurns: { said: (sessionId, turn) => chat.said(sessionId, turn) },
    served: (sessionId) => notServed(ledger.get(sessionId), providers.forSession(sessionId)),
    turnOf: (sessionId) => turnContexts.of(sessionId),
    callTime,
    turnWake: settleTurnWake,
    jobs: scheduleFor,
    directory: (sessionId) => directoryEntries(hostDeps, sessionId),
    addressOf: (sessionId) => {
      const entry = ledger.get(sessionId)
      return entry ? sessionAddress(sessionId, entry.projectId) : null
    },
    deliver,
    receives: (sessionId) => sessionMessaging(providers.forSession(sessionId), ledger.get(sessionId)).supported,
    timeZone: () => zoneLabel(userTimeZone()),
    serverVersion: ABOUT.version,
  })

  const hostDeps: HostDeps =
    { spaces, bridge, chat, turns, time, providers, reportedModels, memoryUnavailable: memory.unavailable, hookToken, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, spawns, workers: startWorker, spawnToken, outsideToken: loadMessageToken(MESSAGE_TOKEN_FILE), deliver, hygiene, agents, brainMcp, mcpUrl, hooksUrl, cockpitMcp, sessionGone, sessionTask, sessionNamed, turnEnded: terminalTurnDone, answered: (sessionId: string) => { void taskRouter.answered(sessionId) }, userWrote: (sessionId: string) => userWrote(sessionId), turnStarted: (sessionId: string) => terminalTurns.forget(sessionId), createTask, timeZone: () => userTimeZone(), cycles,
      taskLease: { stale: taskLease.stale, putAway: taskLease.putAway, contextTokensOf }, tasks: { board: taskBoard, commands: taskCommands, split: splitSession, brief: splitBrief, sort: sortSession, records: taskRecords, startOnTask, migration: taskStateMigration },
      jobs: { tool: scheduleTool, zones: jobStore, spawnToken, callerOf: jobCaller },
      channelBridge: bridgeFiles(),
      replyTexts: async (sessionId) => {
        const events = await earlierConversation(sessionId)
        return events ? events.flatMap((event) => (event.kind === 'text' ? [event.text] : [])) : null
      },
      push: { store: pushStore, notifier: pushNotifier },
      // The channel bridge: a message for a task goes to a session by the four-line order, never skipped (application/job-runner.ts wake).
      jobContract: { store: jobStore, spaceIds: jobSpaceIds, wake: (record, channel, text, key) => jobRunner.wake(record, channel, text, key), held: (record) => jobRunner.held(record) },
    }
  const host = createHostServer(hostDeps, origins)

  await new Promise<void>((resolve, reject) => {
    host.once('error', (err: NodeJS.ErrnoException) => reject(portError(err, hostPort)))
    host.listen(hostPort, '127.0.0.1', resolve)
  })
  log(`cockpit: ${url}`)
  // The week's cycle in each space; checked hourly, the week turns at the user's midnight.
  cycles.every(60 * 60_000)
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
      flagged(sessionId)
    },
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }),
    waitForRoom: () => waitForRoom(() => startWorker.hasRoom()),
    log,
  }).then((recovered) => { if (recovered > 0) log(`[worker] ${recovered} worker(s) continue after the restart`) })
  // A worker no tab takes starts without a pane (worker-start.ts).
  const workers = new WorkerStarter({
    spawns, log, stale: taskLease.stale,
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
  // A jobs.json that could not be parsed, or whose version this cockpit does not know, is set aside, never
  // overwritten, and the user is told once (job-store.ts).
  try {
    const aside = jobStore.setAsideUnreadable()
    const why = jobStore.notUsable()
    if (aside && why) notifier.notify(jobsSetAsideNotice(why, aside))
  } catch (err) {
    log(`[jobs] jobs.json ${jobStore.notUsable() === 'unknown-version' ? 'has an unknown version' : 'could not be read'} and could not be set aside: ${(err as Error).message}`)
  }
  jobRunner.start()
  // Brain schema 23: waits held back in held-waits.json move into their tasks' waits, once.
  void taskRouter.adoptHeldWaits()
  // Brain schema 24: the jobs of a version 1 jobs.json move onto their tasks, once (application/job-migration.ts).
  // What a brain did not take (it was not up or not migrated yet, or a write failed) is tried again for as long as
  // jobs wait, and the user is told of a space whose schedules do not fire meanwhile (application/job-migration-watch.ts).
  createMigrationWatch({
    run: () => jobMigration.run(),
    pending: () => pendingSpaces(Object.values(jobStore.pendingV1()?.jobs ?? {}), spaces.list().map(runnerSpaceOf)),
    notify: (input) => notifier.notify(input),
    now: () => Date.now(),
    log,
    later: (fn, ms) => { setTimeout(fn, ms).unref?.() },
  }).start()
  // What a session said in a turn that ended while the host went down, or whose route failed, reaches its task now
  // (application/unrouted-turns.ts): first once the brain and the resumed sessions have settled, then every minute.
  const routeLeftovers = () => routeUnrouted({ ledger, router: taskRouter, working: (sessionId) => turns.get(sessionId)?.state === 'working', log })
    .then((tried) => (tried > 0 ? taskBoard.refresh() : undefined)).catch((err) => log(`[router] left-over turns: ${(err as Error).message}`))
  setTimeout(() => { void routeLeftovers() }, UNROUTED_FIRST_MS).unref?.()
  setInterval(() => { void routeLeftovers() }, UNROUTED_TICK_MS).unref?.()
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

// Left-over turns (application/unrouted-turns.ts): the first look after the host starts, then how often.
const UNROUTED_FIRST_MS = 20_000
const UNROUTED_TICK_MS = 60_000
// Between two workers resumed after a restart: each one's start (agent CLI, MCP servers) settles first.
// How often the task runner looks for plan steps that are ready, besides after every turn.
const RUNNER_TICK_MS = 60_000
// How often the next-step check looks at sessions it put off (an answer not seen yet, a pane still open).
const NEXT_STEP_TICK_MS = 10_000
// Run records: a sync writes only what changed; the first waits for the sessions a restart brings back.
const RUN_SYNC_MS = 60_000
const RUN_FIRST_SYNC_MS = 30_000
/** Pending task board commands are applied once their undo window is over. */
const TASK_COMMAND_TICK_MS = 1000
/**
 * The task board refreshes this often while a page looks at it, and not at all while none does: a safety net, as
 * changes arrive within a second through its watch on the brains' log heads.
 */
const TASK_BOARD_REFRESH_MS = 60_000
const TASK_BOARD_VIEWED_MS = 120_000
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
  .then(async (handled) => handled || runMigrateJobsCommand(process.argv.slice(2)))
  .then(async (handled) => handled || runAgentCommand(process.argv.slice(2)))
  .then((handled) => { if (!handled) return main() })
  .catch((e) => { log(`cockpit host error: ${e.message}`); process.exit(1) })
