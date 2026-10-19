import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { APP_DIR, CLAUDE_RUNTIME_DIR, CODEX_RUNTIME_DIR, COCKPIT_HOME, CONFIG_FILE, HOST_ROOT } from '../paths.js'
import { MAIN_REGISTRY_FILE } from '../project-registry.js'
import { platform } from '../infrastructure/platform/index.js'
import { serviceStatus } from '../service.js'
import { createRedactor } from './redact.js'

/**
 * `eml-cockpit diagnose` — what a maintainer needs to work on an issue, as one
 * Markdown block for the report-issue skill (or a user to paste): versions, the
 * agent runtimes' and the updater's state, the autostart, and the host log's
 * errors and tail. Never a prompt, a transcript or brain content: the host log
 * holds none, and everything personal is redacted (redact.ts) before printing.
 */

const LOG_TAIL = 150
const ERROR_SCAN = 3000
const MAX_ERRORS = 40
const MAX_LINE = 400
// What points at a problem; "0 failed" (a sweep's summary) and a detached pane's timeout do not.
const ERROR_LINE = /\b(error|(?<!\b0 )failed|failure|fatal|unsupported|EBUSY|EPERM|EACCES|EADDRINUSE|ENOENT|ECONNREFUSED|uncaught|unhandled|cannot|could not)\b/i

const readJson = (file: string): Record<string, unknown> | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> } catch { return null }
}

const readLines = (file: string): string[] => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim()).map((l) => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)} …` : l))
  } catch { return [] }
}

/** Every registry of this home: main and the further spaces'. */
function registries(): Array<Record<string, unknown>> {
  const files = [MAIN_REGISTRY_FILE]
  try {
    for (const id of fs.readdirSync(path.join(COCKPIT_HOME, 'spaces'))) files.push(path.join(COCKPIT_HOME, 'spaces', id, 'projects.json'))
  } catch { /* main only */ }
  return files.map(readJson).filter((r): r is Record<string, unknown> => r !== null)
}

/** The personal strings this home knows: project folders and names, space names, session titles. */
function personalStrings(): { paths: string[]; names: string[] } {
  const paths: string[] = []
  const names: string[] = []
  for (const registry of registries()) {
    for (const entry of Object.values((registry.projects ?? {}) as Record<string, Record<string, unknown>>)) {
      if (typeof entry.path === 'string') paths.push(entry.path)
      for (const key of ['displayName', 'customName'] as const) if (typeof entry[key] === 'string') names.push(entry[key] as string)
    }
  }
  const config = readJson(CONFIG_FILE)
  if (typeof config?.mainName === 'string') names.push(config.mainName)
  for (const space of (Array.isArray(config?.spaces) ? config.spaces : []) as Array<Record<string, unknown>>) {
    if (typeof space.name === 'string') names.push(space.name)
  }
  const sessions = readJson(path.join(COCKPIT_HOME, 'sessions.json'))
  for (const s of Object.values((sessions?.sessions ?? {}) as Record<string, Record<string, unknown>>)) {
    if (typeof s.title === 'string') names.push(s.title)
  }
  return { paths, names }
}

function ownVersion(): string {
  return (readJson(path.join(HOST_ROOT, 'package.json'))?.version as string | undefined) ?? 'unknown'
}

/** How this host runs: an installed app version, a source checkout, the dev cockpit. */
function runMode(): string {
  if (process.env.EML_COCKPIT_DEV === '1') return 'dev cockpit (source)'
  try {
    const rel = path.relative(fs.realpathSync(path.join(APP_DIR, 'versions')), fs.realpathSync(HOST_ROOT))
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return 'installed app'
  } catch { /* no app dir */ }
  return 'source checkout'
}

const result = (r: unknown): string => {
  if (!r || typeof r !== 'object') return 'none'
  const { outcome, from, to, at, error } = r as Record<string, unknown>
  return [outcome, from || to ? `${from ?? '–'} → ${to ?? '–'}` : null, at ? `at ${at}` : null, error ? `error: ${error}` : null]
    .filter(Boolean).join(', ')
}

function runtimeLine(label: string, dir: string): string {
  const state = readJson(path.join(dir, 'runtime.json'))
  if (!state) return `- ${label}: not installed`
  return `- ${label}: ${state.current ?? 'none'} (previous ${state.previous ?? 'none'}, auto-update ${state.autoUpdate === false ? 'off' : 'on'}) · last: ${result(state.lastResult)}`
}

export async function diagnose(): Promise<string> {
  const service = await serviceStatus().catch((e: Error) => ({ error: e.message }))
  const update = readJson(path.join(APP_DIR, 'update.json'))
  const log = path.join(COCKPIT_HOME, 'host.log')
  const lines = readLines(log)
  const errors = [...new Set(lines.slice(-ERROR_SCAN).filter((l) => ERROR_LINE.test(l)))].slice(-MAX_ERRORS)

  const report = [
    '### Diagnostics',
    '',
    `- cockpit: ${ownVersion()} (${runMode()})`,
    `- os: ${platform.os} ${os.release()} ${process.arch} · node ${process.version}`,
    'error' in service
      ? `- autostart: ${service.error}`
      : `- autostart: ${service.installed ? 'installed' : 'not installed'} · ${service.running ? 'running' : 'not running'} · port ${service.port} ${service.responds ? 'responds' : 'no response'}`,
    runtimeLine('claude code', CLAUDE_RUNTIME_DIR),
    runtimeLine('codex', CODEX_RUNTIME_DIR),
    update
      ? `- app updates: previous ${update.previous ?? 'none'}, latest seen ${(update.latest as { version?: string } | null)?.version ?? 'none'} · last: ${result(update.lastResult)}${update.lastError ? ` · last check error: ${update.lastError}` : ''}`
      : '- app updates: no state (not an installed app, or never checked)',
    '',
    `#### Errors in the host log (last ${ERROR_SCAN} lines)`,
    '',
    '```',
    ...(errors.length ? errors : ['(none)']),
    '```',
    '',
    `#### Host log (last ${LOG_TAIL} lines)`,
    '',
    '```',
    ...(lines.length ? lines.slice(-LOG_TAIL) : [`(no log at ${log})`]),
    '```',
  ].join('\n')

  const redact = createRedactor({
    cockpitHome: COCKPIT_HOME,
    home: os.homedir(),
    user: os.userInfo().username,
    ...personalStrings(),
  })
  return redact(report)
}
