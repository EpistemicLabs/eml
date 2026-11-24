#!/usr/bin/env node
// First: a host without a console sends its output to its log file from here on (log-file.ts).
import './log-file.js'
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
import { PtyBridge } from './pty-bridge.js'
import { pluginStates, pluginStore, spacePlugins } from './plugins-api.js'
import { importBridgeAccounts, ownsBridgeAccounts, writeBridgeAccounts } from './infrastructure/plugins/bridge-accounts.js'
import { bridgeAccountsFor } from './domain/space-plugins.js'
import { readAgentMcpDefinitions, readAgentRuntime } from './agent-runtime.js'
import { writeCodexPluginServers } from './infrastructure/providers/codex/index.js'
import { readRemoteAccess } from './remote-access.js'
import { ChatBridge, IDLE_STOP } from './chat-bridge.js'
import { terminalBusyState } from './domain/session-lifecycle.js'
import { sessionsBlockRunner } from './domain/runner-busy.js'
import { StartWorker } from './application/start-worker.js'
import { deliverMessage, type MessageRequest } from './application/deliver-message.js'
import { interruptedWorkers, recoverWorkers } from './application/recover-workers.js'
import { shutDownOnSignal } from './application/shut-down.js'
import type { SpawnRequest } from './domain/spawn-request.js'
import { loadMessageToken } from './message-token.js'
import { sessionAddress } from './session-address.js'
import { InMemoryEventStore } from './application/session-events.js'
import { SessionHandoff } from './application/session-handoff.js'
import { createClaudeSdkRuntimes } from './infrastructure/providers/claude/sdk-runtime.js'
import { ABOUT, createHostServer } from './http.js'
import { getFreePort } from './ports.js'
import { TurnTracker, type TurnEvent } from './turn-state.js'
import { TimeTracker } from './time-tracking.js'
import { brainForLocalToken } from './brain-info.js'
import { BrainSpaces, openBrainSpace, sessionSpaceOf, type BrainSpace } from './brain-space.js'
import { HOOKS_PATH, MCP_PATH, boundAgent, createBrainMcpHandler, sessionClient } from './brain-mcp.js'
import { createSessionTask, displayTitleOf, kebabTitle } from './application/session-task.js'
import { brainIdFromProjectId } from './project-registry.js'
import { createTaskRouter } from './application/task-router.js'
import { createTaskRunner, stepPrompt } from './application/task-runner.js'
import { createNextStepCheck } from './application/next-step.js'
import { createCycles } from './application/cycles.js'
import { loadAgentBrains } from './agents.js'
import { upgradeAtStart } from './agent-upgrade.js'
import { runUpgradeAgentsCommand } from './agent-upgrade-cli.js'
import { BACKUPS_DIR, CHANNEL_BRIDGE_ACCOUNTS_FILE, CONFIG_DIR, DATA_DIR, PLUGINS_HOME } from './paths.js'
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
import { JobStore } from './job-store.js'
import { JobRunner } from './application/job-runner.js'
import { Jobs, type JobAnswer, type JobCaller } from './application/jobs.js'
import { resolveProject } from './spawn-api.js'
import { ensureJobTokens, jobSpaceIdsOf } from './job-contract-api.js'
import { channelJobFacts, isChannelJob, withChannelTools } from './application/channel-job-launch.js'
import { lendJobTool, type JobSessions } from './application/lend-job-tool.js'
import { clearJobProfile } from './application/clear-job-profile.js'
import { takeBackJobTools } from './application/take-back-job-tools.js'
import { sessionJobFacts } from './application/limited-job-scope.js'
import { isHeld, type GrantTool, type Job } from './domain/job.js'
import { bridgeServerFor, startChannelBridge } from './infrastructure/channel-bridge/channel-bridge.js'
import { bridgeFiles } from './channel-bridge-api.js'
import { createClaudeProvider } from './infrastructure/providers/claude/index.js'
import type { Notifier } from './notifications.js'
import { PushStore } from './push-store.js'
import { PushNotifier, notifySessions } from './application/push-notifier.js'
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
import { createScheduleMirror } from './application/schedule-mirror.js'
import { scheduleOfJobs } from './domain/task-schedule.js'
import { scheduledJobOptions } from './domain/hand-over.js'
import { createTaskStateMigration } from './application/task-state-migration.js'
import { liveFactsOf, runsBlockRunner, type RunFacts } from './domain/runs.js'
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
  const hooksUrl = `http://127.0.0.1:${hostPort}${HOOKS_PATH}`

  // Each agent CLI writes the files its sessions share across spaces (for
  // Claude Code: the turn-hook config, the skills, .claude.json; for Codex:
  // config.toml and hooks.json). A space's own files follow below.
  for (const provider of providers.all()) {
    provider.prepare({ hookUrl, hookToken, mcpUrl, writableDirs: [SPAWN_INBOX_DIR, TASKS_DIR] })
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
  // Task system: every session works on a brain task (application/session-task.ts).
  const taskBrain = (space: BrainSpace) => {
    const agent = boundAgent({ agents }, space)
    return 'refused' in agent ? null : sessionClient(space, agent)
  }
  const sessionTask = createSessionTask({ ledger, spaces, brain: taskBrain, jobTask: (jobId) => jobStore.get(jobId)?.taskId ?? null })
  // The router: whose turn it is after a session's turn, written into its task (application/task-router.ts).
  const owner = config?.handle ?? 'user'
  const taskRouter = createTaskRouter({
    ledger, spaces, brain: taskBrain, owner, log,
    // A worker that closed its step leaves the lists; one the user started or pinned stays where they put it.
    finished: (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry?.worker || entry.pinned || entry.deskMain) return
      ledger.archive(sessionId)
    },
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
  const runnerBusy = (taskId: string, runs: readonly RunFacts[] = []) => {
    const own = ledger.list().filter((e) => e.taskId === taskId)
    return sessionsBlockRunner(
      own.map((e) => ({ createdAt: e.createdAt, archived: Boolean(e.archivedAt), working: turns.get(e.sessionId)?.state === 'working' })),
      taskCommands?.delegatedAt(taskId) ?? null,
    ) || runsBlockRunner(runs, new Set(own.map((e) => e.sessionId)), Date.now())
  }
  // An undoable hand-over, or Work on it now: the owner works with the agent, which never goes on alone.
  const lastResults = new Map<string, string>()
  // Set once the turns and the session runtimes exist; turnEnded pokes it.
  let runRecords: RunRecords = { sync: async () => {}, poke: () => {}, every: () => () => {} }
  const runnerHeld = (taskId: string) => (taskCommands?.held(taskId) || taskCommands?.together(taskId)) ?? false
  // What holds one of the runner's slots: a session in a turn on the task, here or in another cockpit's run (domain/runs.ts).
  const taskSessions = (taskId: string) => ledger.list().filter((e) => e.taskId === taskId && !e.archivedAt)
    .map((e) => ({ sessionId: e.sessionId, working: turns.get(e.sessionId)?.state === 'working' }))
  const taskRunner = createTaskRunner({
    spaces, brain: taskBrain, me: owner, log,
    busy: runnerBusy,
    working: (taskId, runs) => liveFactsOf(taskSessions(taskId), runs, null, Date.now()).working,
    scheduled: (taskId) => jobStore.list().some((job) => job.taskId === taskId && !job.endedAt && !isHeld(job) && job.nextRunAt !== null),
    held: runnerHeld,
    brief: (taskId) => taskCommands?.briefOf(taskId),
    start: (space, step) => {
      const problem = ensureTaskProject(space, step.projectId)
      if (problem) return problem
      spawns.add({
        projectId: step.projectId, prompt: stepPrompt(step, step.checkpoint), title: step.title, fromSessionId: null,
        origin: 'runner', taskId: step.id, ...(space.main ? {} : { spaceId: space.id }),
      })
      return null
    },
  })
  taskRunner.every(RUNNER_TICK_MS)
  // The next-step check: a delegated task always has a next trigger (application/next-step.ts).
  const nextStep = createNextStepCheck({
    ledger, spaces, brain: taskBrain, owner, log,
    jobsOf: (taskId) => jobStore.list().filter((job) => job.taskId === taskId).map((job) => ({
      ended: Boolean(job.endedAt), held: isHeld(job), nextRunAt: job.nextRunAt,
      channel: job.triggers.some((trigger) => trigger.type !== 'schedule'),
      runWaiting: jobStore.runs(job.id).some((run) => run.status === 'waiting'),
    })),
    runStartedAt: (sessionId) => {
      const entry = ledger.get(sessionId)
      const run = entry?.jobId ? jobStore.runs(entry.jobId).filter((r) => r.sessionId === sessionId && r.startedAt).at(-1) : undefined
      return run?.startedAt ?? entry?.createdAt ?? ''
    },
    working: (sessionId) => turns.get(sessionId)?.state === 'working',
    watched: (sessionId) => chat.sessionState(sessionId) === 'running' || bridge.sessionState(sessionId) === 'running',
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }).then((outcome) => outcome === 'delivered' || outcome === 'resumed'),
    waiting: (sessionId) => flagged(sessionId),
    // Like a finished worker: one the user pinned or put on the desk stays.
    quiet: (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry?.worker || entry.pinned || entry.deskMain) return
      ledger.archive(sessionId)
    },
  })
  setInterval(() => { void nextStep.tick() }, RUNNER_TICK_MS).unref?.()
  // Weekly cycles (application/cycles.ts): the week's subject, and what the last cycle left carried over.
  const cycles = createCycles({ spaces, log, me: owner, brain: (space) => taskBrain(space) as ReturnType<typeof sessionClient> | null, timeZone: () => userTimeZone() })
  // A turn ended: whose turn it is goes into the task, and a step it finished may let the next one start.
  const turnEnded = (sessionId: string, text: string) => {
    // The run keeps the result line of the session's last handoff (application/run-records.ts).
    const result = parseHandoff(text)?.result
    if (result) lastResults.set(sessionId, result)
    runRecords.poke()
    void taskRouter.turnEnded(sessionId, text).then(() => nextStep.turnEnded(sessionId)).then(() => taskRunner.tick())
      .then(() => taskBoard.refresh()).catch((err) => log(`[task] after turn: ${(err as Error).message}`))
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
  // The spawn API's newTask: written into the brain at once (decision no-task-triage).
  const createTask = async (space: BrainSpace, input: { title: string; content: string; scope: string }) => {
    const display = displayTitleOf(input.title)
    const fields = { title: kebabTitle(input.title) ?? input.title, ...(display ? { display_title: display } : {}), content: input.content, scope: input.scope, status: 'active' }
    const brain = taskBrain(space)
    if (!brain) return { error: `space ${space.name} has no agent` }
    const post = (scope: string) => brain.post('/engram/task', { ...fields, scope }) as Promise<{ id: string }>
    try {
      return await post(input.scope).catch(() => post('global'))
    } catch (err) {
      return { error: (err as Error).message }
    }
  }
  watchSpawnInbox({ spawns, spawnToken, spaces, ledger, providers, deliver, sessionNamed, createTask, jobs: { jobs: { handle: (caller, input) => jobs.handle(caller, input) }, callerOf: (id) => jobCaller(id) } })
  // A conversation runs in one process, in the terminal or the chat view (session-handoff.ts).
  const handoff = (): SessionHandoff => sessionHandoff
  const bridge = new PtyBridge({
    ledger, providers, spaces, sessionEnv, handoff, chatHolds: (sessionId) => chat.isRunning(sessionId),
    memory, sessionLimits: () => sessionLimits(readLimits()),
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
  const sdkRuntimes = createClaudeSdkRuntimes()
  const chat = new ChatBridge({
    ledger, providers, spaces, sessionEnv,
    runtimes: sdkRuntimes,
    events: new InMemoryEventStore(),
    onTurn: (sessionId, state) => turns.apply({ sessionId, state }),
    turnDone: turnEnded,
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
      const jobId = ledger.get(sessionId)?.jobId
      const job = jobId ? jobStore.get(jobId) : undefined
      return job ? { id: job.id, name: job.name, limited: job.limited === true } : null
    },
    clearJobProfile: (jobId) => clearJobProfile(jobStore, jobId),
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
  // Turn state starts empty. A saved question or failure is not turned back into waiting: the desk dot
  // shows what is new until it is seen, the Inbox and Your turn hold what needs an answer, and only a
  // live prompt keeps a session waiting (decision desk-dot-until-seen).
  spawns.on('spawn', (request: SpawnRequest) => {
    if (request.fromSessionId) ledger.expectParent(request.id, request.fromSessionId)
    if (request.origin === 'split' || request.origin === 'task') ledger.expectOwn(request.id)
  })
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
  const projectName = (spaceId: string | null, projectId: string | null) =>
    projectId ? spaces.resolve(spaceId).registry.get(projectId)?.displayName : undefined
  // Sessions tell what the review section shows: Needs you, Check this, a new result.
  notifySessions({ turns, notifier, facts: (sessionId) => sessionFacts({ ledger, turns, projectName }, sessionId) })
  const userTimeZone = () => jobStore.timeZone() ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  const jobCaller = (sessionId: string): JobCaller | null => {
    const entry = ledger.get(sessionId)
    if (!entry) return null
    // A limited job's session reaches only its own job, and nothing once that job is gone (limited-job-scope.ts).
    const facts = sessionJobFacts(entry.jobId ?? null, entry.jobId ? jobStore.get(entry.jobId) : undefined)
    // A job belongs to the task its maker works on.
    return { sessionId, spaceId: entry.spaceId ?? null, projectId: entry.projectId, toolProfile: entry.toolProfile, taskId: entry.taskId, ...facts }
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
      log(`[jobs] tell: job=${input.jobId?.slice(0, 8) ?? '-'} kind=${input.kind}`)
      notifier.notify(withProject({ ledger, projectName }, input))
    },
    // In the review section, as "Needs you": the job's own session if it has one, else whoever made it.
    flag: (job, text) => {
      const own = job.target.type === 'worker' ? null : job.target.sessionId
      const sessionId = [own, job.createdBy].find((id): id is string => !!id && ledger.has(id))
      if (!sessionId) return
      ledger.setAttention(sessionId, { kind: 'failed', reason: text.slice(0, 300) })
      flagged(sessionId)
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
    // The main space is local by construction; any other counts as shared until the brain server said otherwise.
    sharedSpace: (spaceId) => {
      const space = spaces.resolve(spaceId)
      return !space.main && space.shared !== false
    },
    onGrant, onGrantEnd,
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
      archived: Boolean(e.archivedAt), jobId: e.jobId, worker: e.worker, parentSessionId: e.parentSessionId,
    })),
    turnOf: (sessionId) => turns.get(sessionId)?.state,
    processRuns: (sessionId) => chat.isRunning(sessionId) || bridge.isRunning(sessionId),
    resultOf: (sessionId) => lastResults.get(sessionId) ?? null,
    agentOf: (space) => space.agent,
    log,
  })
  turns.on('turn', () => runRecords.poke())
  // A task's schedule lives in the brain: this cockpit's jobs mirror their timing into it (application/schedule-mirror.ts).
  const scheduleMirror = createScheduleMirror({
    spaces: () => spaces.list(), brain: taskBrain, jobs: () => jobStore.list(), agentOf: (space) => space.agent, me: owner, now: () => Date.now(), log,
  })
  setTimeout(() => { void scheduleMirror.sync() }, RUN_FIRST_SYNC_MS).unref?.()
  scheduleMirror.every(RUN_SYNC_MS)
  // The first sync waits for sessions a restart brings back, so their runs are not ended as crashed first.
  setTimeout(() => { void runRecords.sync() }, RUN_FIRST_SYNC_MS).unref?.()
  runRecords.every(RUN_SYNC_MS)

  // The task board (application/task-board.ts) and its commands with Undo (application/task-commands.ts).
  const taskBoard = createTaskBoard({
    spaces: () => spaces.list(),
    brain: taskBrain,
    viewer: owner,
    sessionsOn: taskSessions,
    nextRunOf: (taskId) => jobStore.list().filter((job) => job.taskId === taskId && !job.endedAt && !isHeld(job) && job.nextRunAt)
      .map((job) => job.nextRunAt!).sort()[0] ?? null,
    scheduleOf: (taskId) => scheduleOfJobs(jobStore.list().filter((job) => job.taskId === taskId)),
    snoozes: () => taskCommands?.snoozes() ?? [],
    pendingCommands: () => taskCommands?.pending() ?? [],
    releasedAgent: (taskId) => taskCommands?.releasedAgent(taskId) ?? null,
    reopenedWith: (taskId) => taskCommands?.reopenedWith(taskId) ?? [],
    ledgerSessionsOn: (taskId) => ledger.list().filter((e) => e.taskId === taskId).map((e) => e.sessionId),
    runnerBusy, runnerHeld,
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
    jobs: () => jobStore.list(),
    setJobTask: (jobId, taskId) => { const job = jobStore.get(jobId); if (job) jobStore.put({ ...job, taskId, updatedAt: new Date().toISOString() }) },
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
    createJob: async (space, task, spec, prompt) => {
      const brainProject = task.scope.startsWith('project.') ? task.scope.slice('project.'.length) : null
      if (!brainProject) return { error: `the task has no project to run in (scope ${task.scope})` }
      const projectId = projectIdForBrain(brainProject)
      const problem = ensureTaskProject(space, projectId)
      if (problem) return { error: problem }
      const newest = ledger.list().filter((e) => e.taskId === task.id)
        .sort((a, b) => Date.parse(b.lastAttached ?? b.createdAt) - Date.parse(a.lastAttached ?? a.createdAt))[0]?.sessionId ?? null
      const how = scheduledJobOptions(spec, { goal: task.properties?.goal }, newest)
      const answer = await jobs.handle(
        { sessionId: how.callerSessionId, spaceId: space.ledgerKey, projectId, toolProfile: null, taskId: task.id },
        { action: 'create', name: task.title ?? task.id, prompt, task_id: task.id, ...how.input },
      )
      return answer.job ? { jobId: answer.job.id } : { error: answer.text }
    },
    sessionsSince: (taskId, since) => {
      const on = ledger.list().filter((e) => e.taskId === taskId && Date.parse(e.createdAt) >= Date.parse(since))
      return { total: on.length, open: on.filter((e) => !e.archivedAt).length }
    },
    // Send in a closed task's chat: the message goes to its newest session, or starts one when it has none.
    newestSessionOn: (taskId) => ledger.list().filter((e) => e.taskId === taskId)
      .sort((a, b) => Date.parse(b.lastAttached ?? b.createdAt) - Date.parse(a.lastAttached ?? a.createdAt))[0]?.sessionId ?? null,
    deliver: (sessionId, text) => deliver({ target: sessionId, text, from: null, caller: 'session' }).then((outcome) => outcome === 'delivered' || outcome === 'resumed'),
    startOnTask: async (spaceId, taskId, prompt) => {
      const started = await startOnTask({ spaceId, taskId, prompt })
      return started.ok ? started.sessionId : null
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
  const splitBrief = createSplitBrief({
    transcript: async (sessionId) => {
      const entry = ledger.get(sessionId)
      if (!entry || entry.provider !== 'claude' || !entry.projectId) return null
      const space = spaces.resolve(entry.spaceId)
      const projectPath = space.registry.get(entry.projectId)?.path
      if (!projectPath) return null
      const conversationId = ledger.ref(sessionId, null).providerSessionId ?? sessionId
      return sdkRuntimes.history(conversationId, projectPath, space.runtime).catch(() => null)
    },
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
    endSession: async (sessionId) => {
      bridge.killSession(sessionId)
      await chat.end(sessionId, 'split undone')
      ledger.setTurnInFlight(sessionId, false)
      turns.forget(sessionId)
      ledger.archive(sessionId)
    },
    changed: () => { void taskBoard.refresh().catch(() => {}) },
    now: () => Date.now(),
    log,
  })

  const brainMcp = createBrainMcpHandler({ spaces, agents, ledger, providers, serverVersion: ABOUT.version })

  const host = createHostServer(
    { spaces, bridge, chat, turns, time, providers, memoryUnavailable: memory.unavailable, hookToken, turnHookConfig: CLAUDE_TURN_HOOK_CONFIG, spawns, workers: startWorker, spawnToken, outsideToken: loadMessageToken(MESSAGE_TOKEN_FILE), deliver, hygiene, agents, brainMcp, mcpUrl, hooksUrl, sessionTask, sessionNamed, turnEnded, answered: (sessionId: string) => { void taskRouter.answered(sessionId) }, userWrote: (sessionId: string) => userWrote(sessionId), createTask, timeZone: () => userTimeZone(), cycles,
      tasks: { board: taskBoard, commands: taskCommands, split: splitSession, brief: splitBrief, sort: sortSession, startOnTask, migration: taskStateMigration },
      jobs: { jobs, store: jobStore, spawnToken, callerOf: jobCaller, spaceName: (spaceId) => spaces.resolve(spaceId).name,
        sessionInfo: (sessionId) => {
          const entry = ledger.get(sessionId)
          return entry ? { projectId: entry.projectId, chat: entry.runtime === 'sdk', attention: entry.attention?.kind ?? null } : null
        },
      },
      channelBridge: bridgeFiles(),
      push: { store: pushStore, notifier: pushNotifier },
      jobContract: { store: jobStore, spaceIds: jobSpaceIds, wake: (job, channel, text, key) => jobRunner.wake(job, channel, text, key) },
    },
    origins,
  )

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
  // Brain schema 23: waits held back in held-waits.json move into their tasks' waits, once.
  void taskRouter.adoptHeldWaits()
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
// How often the task runner looks for plan steps that are ready, besides after every turn.
const RUNNER_TICK_MS = 60_000
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
  .then(async (handled) => handled || runAgentCommand(process.argv.slice(2)))
  .then((handled) => { if (!handled) return main() })
  .catch((e) => { log(`cockpit host error: ${e.message}`); process.exit(1) })
