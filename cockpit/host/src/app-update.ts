import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { APP_DIR, COCKPIT_HOME, HOST_ROOT } from './paths.js'
import { platform } from './infrastructure/platform/index.js'
import { SERVICE_ENV } from './domain/autostart.js'
import { FS_RETRY, renameWithRetry } from './fs-retry.js'

/**
 * The cockpit's own updater (decisions app-update-flow, cockpit-update-source).
 * An installed cockpit lives in its home:
 *
 *   <home>/app/versions/<v>/node_modules/eml-cockpit   an installed release, never modified
 *   <home>/app/current -> versions/<v>                 what the service runs (a junction on Windows)
 *   <home>/app/update.json                             current/previous, last check, last result
 *
 * Releases come from GitHub Releases (tag v<X.Y.Z>; assets: the eml-cockpit and
 * mcp-server tarballs + SHA256SUMS). Nothing installs on its own: the host only
 * checks; the user clicks Update. An update downloads and verifies both
 * tarballs, installs them into their own version folder, switches `current` in
 * one rename and exits — the service starts the new version, whose brain server
 * migrates the brain through the safety pipeline. The previous version stays
 * for "go back" (refused across a schema minor: the brain has moved on).
 *
 * The repository is public, so no token is needed. An optional read-only token
 * (raises GitHub's rate limit) comes from the file <home>/github-token (chmod
 * 600, write-only from the browser) or, failing that, a logged-in `gh` CLI.
 * A dev cockpit (run from source) has no updater.
 */

const REPO = process.env.EML_COCKPIT_UPDATE_REPO || 'EpistemicLabs/eml'
const API = (process.env.EML_COCKPIT_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '')
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const FIRST_CHECK_DELAY_MS = 60 * 1000
const LOCK_STALE_MS = 15 * 60 * 1000
const VERSION_RE = /^\d+\.\d+\.\d+$/

const VERSIONS_DIR = path.join(APP_DIR, 'versions')
const CURRENT_LINK = path.join(APP_DIR, 'current')
const STATE_FILE = path.join(APP_DIR, 'update.json')
const LOCK_FILE = path.join(APP_DIR, '.lock')
export const GITHUB_TOKEN_FILE = path.join(COCKPIT_HOME, 'github-token')

/** Where the service runs the host from when this cockpit is an installed app. */
export const CURRENT_HOST_ROOT = path.join(CURRENT_LINK, 'node_modules', 'eml-cockpit')

export interface UpdateResult {
  at: string
  outcome: 'updated' | 'rolled_back' | 'failed'
  from?: string
  to?: string
  error?: string
}

interface UpdateState {
  previous: string | null
  /** Where the last check got its token from ('gh' is only known after a check). */
  tokenSource: 'file' | 'gh' | 'none'
  /** A version the user went back from — not offered again; a newer release is. */
  skipVersion: string | null
  lastCheckAt: string | null
  latest: { version: string; url: string; publishedAt: string | null } | null
  lastError: string | null
  lastResult: UpdateResult | null
}

export interface AppUpdateStatus {
  /** This host runs from <home>/app/versions/<v> — only then can it update itself. */
  managed: boolean
  current: string
  previous: string | null
  latest: UpdateState['latest']
  available: boolean
  lastCheckAt: string | null
  error: string | null
  lastResult: UpdateResult | null
  token: { source: 'file' | 'gh' | 'none' }
  canRollback: boolean
  rollbackBlocked: string | null
  busy: boolean
}

const DEFAULT_STATE: UpdateState = { previous: null, tokenSource: 'none', skipVersion: null, lastCheckAt: null, latest: null, lastError: null, lastResult: null }

// --- versions -----------------------------------------------------------------

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1
  }
  return 0
}

function minorOf(v: string): string {
  return v.split('.').slice(0, 2).join('.')
}

/** This host's own version. */
export function ownVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HOST_ROOT, 'package.json'), 'utf8')) as { version?: string }
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** The version folder this host runs from, or null when it isn't an installed app of this home. */
function managedVersion(): string | null {
  try {
    const versions = fs.realpathSync(VERSIONS_DIR)
    const rel = path.relative(versions, fs.realpathSync(HOST_ROOT)).split(path.sep)
    if (rel.length === 3 && VERSION_RE.test(rel[0]) && rel[1] === 'node_modules' && rel[2] === 'eml-cockpit') return rel[0]
  } catch { /* no app dir */ }
  return null
}

export function isManaged(): boolean {
  return process.env.EML_COCKPIT_DEV !== '1' && managedVersion() !== null
}

// --- state --------------------------------------------------------------------

function readState(): UpdateState {
  try {
    return { ...DEFAULT_STATE, ...(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<UpdateState>) }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

function writeState(patch: Partial<UpdateState>): UpdateState {
  const state = { ...readState(), ...patch }
  fs.mkdirSync(APP_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.${randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2))
  fs.renameSync(tmp, STATE_FILE)
  return state
}

// --- GitHub access -----------------------------------------------------------------

function run(file: string, args: string[], opts: { cwd?: string; timeout?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH, ...platform.toolDirs].filter(Boolean).join(path.delimiter) }
    execFile(file, args, { cwd: opts.cwd, env, timeout: opts.timeout ?? 30_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = !err ? 0 : typeof err.code === 'number' ? err.code : 1
      resolve({ code, stdout: String(stdout), stderr: String(stderr) })
    })
  })
}

async function githubToken(): Promise<{ token: string | null; source: 'file' | 'gh' | 'none' }> {
  try {
    const token = fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8').trim()
    if (token) return { token, source: 'file' }
  } catch { /* no file */ }
  const gh = await run('gh', ['auth', 'token'], { timeout: 5_000 })
  const token = gh.code === 0 ? gh.stdout.trim() : ''
  return token ? { token, source: 'gh' } : { token: null, source: 'none' }
}

function tokenSourceSync(state: UpdateState): 'file' | 'gh' | 'none' {
  try {
    if (fs.readFileSync(GITHUB_TOKEN_FILE, 'utf8').trim()) return 'file'
  } catch { /* no file */ }
  // `gh` is a subprocess — probed during a check, remembered in the state.
  return state.tokenSource === 'gh' ? 'gh' : 'none'
}

/** Store or remove the GitHub token (write-only from the browser). */
export function writeGithubToken(token: unknown): string | null {
  if (token === null || token === '') {
    fs.rmSync(GITHUB_TOKEN_FILE, { force: true })
    return null
  }
  if (typeof token !== 'string' || !/^(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}$/.test(token.trim())) {
    return 'That does not look like a GitHub token (expected github_pat_…).'
  }
  fs.writeFileSync(GITHUB_TOKEN_FILE, token.trim() + '\n', { mode: 0o600 })
  fs.chmodSync(GITHUB_TOKEN_FILE, 0o600)
  return null
}

interface ReleaseAsset { name: string; url: string; size: number }
interface Release { version: string; url: string; publishedAt: string | null; assets: ReleaseAsset[] }

function githubApiGet(pathname: string, token: string | null): Promise<Response> {
  return fetch(`${API}${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'eml-cockpit',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(30_000),
  })
}

async function githubJson(pathname: string, token: string | null): Promise<unknown> {
  const res = await githubApiGet(pathname, token)
  // A public repository needs no token: an expired or revoked one must not
  // block updates, so a rejected token gets one retry without it.
  if (res.status === 401 && token) {
    const anonymous = await githubApiGet(pathname, null)
    if (anonymous.ok) return anonymous.json()
  }
  if (res.status === 401) throw new Error('GitHub rejected the token (expired or revoked) — replace it in Settings › About › Updates.')
  if (res.status === 404) {
    throw new Error(token
      ? `No release found for ${REPO} (or the token has no access to it).`
      : `No release found for ${REPO}.`)
  }
  if (!res.ok) throw new Error(`GitHub API ${pathname} → HTTP ${res.status}`)
  return res.json()
}

function parseRelease(raw: unknown): Release {
  const r = raw as { tag_name?: string; html_url?: string; published_at?: string | null; assets?: Array<{ name: string; url: string; size: number }> }
  const version = (r.tag_name ?? '').replace(/^v/, '')
  if (!VERSION_RE.test(version)) throw new Error(`release tag '${r.tag_name}' is not vX.Y.Z`)
  return {
    version,
    url: r.html_url ?? '',
    publishedAt: r.published_at ?? null,
    assets: (r.assets ?? []).map((a) => ({ name: a.name, url: a.url, size: a.size })),
  }
}

async function download(asset: ReleaseAsset, dest: string, token: string | null): Promise<void> {
  // The asset API URL redirects to storage; fetch drops Authorization on the
  // cross-origin redirect, so the token only ever goes to the GitHub API.
  const get = (withToken: string | null) => fetch(asset.url, {
    headers: {
      Accept: 'application/octet-stream',
      'User-Agent': 'eml-cockpit',
      ...(withToken ? { Authorization: `Bearer ${withToken}` } : {}),
    },
    signal: AbortSignal.timeout(5 * 60_000),
  })
  let res = await get(token)
  // Same as githubJson: a rejected token gets one retry without it.
  if (res.status === 401 && token) res = await get(null)
  if (!res.ok || !res.body) throw new Error(`download ${asset.name} → HTTP ${res.status}`)
  await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(dest))
  const size = fs.statSync(dest).size
  if (asset.size && size !== asset.size) throw new Error(`${asset.name}: ${size} bytes, expected ${asset.size}`)
}

async function sha256(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(fs.createReadStream(file), hash)
  return hash.digest('hex')
}

// --- lock (one updater per home, also across processes) -----------------------------

function lockOwnerAlive(): boolean {
  const pid = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim())
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isBusy(): boolean {
  try {
    const age = Date.now() - fs.statSync(LOCK_FILE).mtimeMs
    return age <= LOCK_STALE_MS && lockOwnerAlive()
  } catch {
    return false
  }
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(APP_DIR, { recursive: true })
  if (!isBusy()) fs.rmSync(LOCK_FILE, { force: true })
  let fd: number
  try {
    fd = fs.openSync(LOCK_FILE, 'wx')
  } catch {
    return Promise.reject(new Error('an update of this cockpit is already running'))
  }
  fs.writeSync(fd, String(process.pid))
  fs.closeSync(fd)
  return fn().finally(() => fs.rmSync(LOCK_FILE, { force: true }))
}

// --- install ----------------------------------------------------------------------

/** Point `current` at versions/<v> (platform.switchDirLink: a symlink, a junction on Windows). */
function switchCurrent(version: string): void {
  platform.switchDirLink(path.join(VERSIONS_DIR, version), CURRENT_LINK)
}

/** Keep the running version and the one to go back to; drop older ones and stale staging dirs. */
function prune(keep: Array<string | null>): void {
  const names = new Set(keep.filter(Boolean) as string[])
  for (const name of fs.readdirSync(VERSIONS_DIR)) {
    if (!names.has(name)) fs.rmSync(path.join(VERSIONS_DIR, name), { recursive: true, force: true })
  }
  for (const name of fs.readdirSync(APP_DIR)) {
    if (name.startsWith('.staging-')) fs.rmSync(path.join(APP_DIR, name), { recursive: true, force: true })
  }
}

async function installRelease(release: Release, token: string | null): Promise<void> {
  const v = release.version
  const want = [`eml-cockpit-${v}.tgz`, `engramprotocol-mcp-server-${v}.tgz`, 'SHA256SUMS']
  const assets = want.map((name) => {
    const asset = release.assets.find((a) => a.name === name)
    if (!asset) throw new Error(`release v${v} has no asset ${name}`)
    return asset
  })

  const staging = path.join(APP_DIR, `.staging-${v}-${randomBytes(4).toString('hex')}`)
  const tarballs = path.join(staging, 'tarballs')
  fs.mkdirSync(tarballs, { recursive: true })
  try {
    for (const asset of assets) await download(asset, path.join(tarballs, asset.name), token)
    const sums = new Map<string, string>()
    for (const line of fs.readFileSync(path.join(tarballs, 'SHA256SUMS'), 'utf8').split('\n')) {
      const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/)
      if (m) sums.set(m[2], m[1])
    }
    for (const name of want.slice(0, 2)) {
      const expected = sums.get(name)
      if (!expected) throw new Error(`SHA256SUMS has no entry for ${name}`)
      if ((await sha256(path.join(tarballs, name))) !== expected) throw new Error(`${name}: checksum mismatch`)
    }

    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({ name: 'eml-cockpit-app', private: true }, null, 2) + '\n')
    const npm = platform.npm()
    const res = await run(npm.program, [...npm.args, 'install', '--no-fund', '--no-audit', '--omit=dev', `./tarballs/${want[1]}`, `./tarballs/${want[0]}`], { cwd: staging, timeout: 10 * 60_000 })
    if (res.code !== 0) throw new Error(`npm install failed: ${(res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')}`)

    const installed = JSON.parse(fs.readFileSync(path.join(staging, 'node_modules', 'eml-cockpit', 'package.json'), 'utf8')) as { version?: string }
    if (installed.version !== v) throw new Error(`installed eml-cockpit is ${installed.version}, expected ${v}`)
    if (!fs.existsSync(path.join(staging, 'node_modules', 'eml-cockpit', 'dist', 'index.js'))) throw new Error('installed eml-cockpit has no dist/index.js')

    const target = path.join(VERSIONS_DIR, v)
    fs.mkdirSync(VERSIONS_DIR, { recursive: true })
    fs.rmSync(target, { recursive: true, force: true, ...FS_RETRY })
    await renameWithRetry(staging, target)
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true, ...FS_RETRY })
    throw err
  }
}

/** Exit so the service (launchd, the Windows supervisor) starts the version `current` now points at. */
function restartSoon(): void {
  setTimeout(() => process.exit(0), 750).unref()
}

/**
 * Under the autostart service (service.ts) a plain exit restarts the host;
 * otherwise the user restarts it. Services installed before SERVICE_ENV are
 * known by their launchd label.
 */
function serviceManaged(): boolean {
  return process.env[SERVICE_ENV] === '1' || (process.env.XPC_SERVICE_NAME ?? '').startsWith('io.engramprotocol.cockpit.')
}

// --- public API -----------------------------------------------------------------

export function readAppUpdateStatus(): AppUpdateStatus {
  const state = readState()
  const current = ownVersion()
  const managed = isManaged()
  const latest = state.latest
  const previousInstalled = !!state.previous && fs.existsSync(path.join(VERSIONS_DIR, state.previous, 'node_modules', 'eml-cockpit'))
  let rollbackBlocked: string | null = null
  if (previousInstalled && state.previous && minorOf(state.previous) !== minorOf(current) && compareVersions(state.previous, current) < 0) {
    rollbackBlocked = `v${state.previous} uses an older brain schema — going back needs the brain backup from before the update.`
  }
  return {
    managed,
    current,
    previous: previousInstalled ? state.previous : null,
    latest,
    available: managed && !!latest && compareVersions(latest.version, current) > 0 &&
      !(state.skipVersion && compareVersions(latest.version, state.skipVersion) <= 0),
    lastCheckAt: state.lastCheckAt,
    error: state.lastError,
    lastResult: state.lastResult,
    token: { source: tokenSourceSync(state) },
    canRollback: managed && previousInstalled && !rollbackBlocked,
    rollbackBlocked,
    busy: isBusy(),
  }
}

/** Ask GitHub for the newest release. Records the result; never installs. */
export async function checkForUpdate(): Promise<AppUpdateStatus> {
  if (!isManaged()) return readAppUpdateStatus()
  try {
    const { token, source } = await githubToken()
    writeState({ tokenSource: source })
    const release = parseRelease(await githubJson(`/repos/${REPO}/releases/latest`, token))
    writeState({
      lastCheckAt: new Date().toISOString(),
      latest: { version: release.version, url: release.url, publishedAt: release.publishedAt },
      lastError: null,
    })
  } catch (err) {
    writeState({ lastCheckAt: new Date().toISOString(), lastError: (err as Error).message })
  }
  return readAppUpdateStatus()
}

/** Install release v<version> and restart into it. */
export async function applyUpdate(version: unknown): Promise<{ restarting: boolean; status: AppUpdateStatus }> {
  if (!isManaged()) throw new Error('This cockpit runs from source — update it with git, not the updater.')
  if (typeof version !== 'string' || !VERSION_RE.test(version)) throw new Error('version must be X.Y.Z')
  const current = ownVersion()
  if (compareVersions(version, current) <= 0) throw new Error(`v${version} is not newer than the running v${current}`)
  await withLock(async () => {
    try {
      const { token } = await githubToken()
      const release = parseRelease(await githubJson(`/repos/${REPO}/releases/tags/v${version}`, token))
      await installRelease(release, token)
      switchCurrent(version)
      writeState({ previous: current, skipVersion: null, lastError: null, lastResult: { at: new Date().toISOString(), outcome: 'updated', from: current, to: version } })
      prune([version, current])
    } catch (err) {
      writeState({ lastResult: { at: new Date().toISOString(), outcome: 'failed', from: current, to: version, error: (err as Error).message } })
      throw err
    }
  })
  const restarting = serviceManaged()
  if (restarting) restartSoon()
  return { restarting, status: readAppUpdateStatus() }
}

/** Switch back to the previous version (same schema minor only) and restart. */
export async function rollbackUpdate(): Promise<{ restarting: boolean; status: AppUpdateStatus }> {
  const status = readAppUpdateStatus()
  if (!status.managed) throw new Error('This cockpit runs from source — nothing to roll back.')
  if (!status.previous) throw new Error('No previous version to go back to.')
  if (status.rollbackBlocked) throw new Error(status.rollbackBlocked)
  const previous = status.previous
  await withLock(async () => {
    switchCurrent(previous)
    writeState({ previous: status.current, skipVersion: status.current, lastResult: { at: new Date().toISOString(), outcome: 'rolled_back', from: status.current, to: previous } })
  })
  const restarting = serviceManaged()
  if (restarting) restartSoon()
  return { restarting, status: readAppUpdateStatus() }
}

/** Background checks for an installed app: a minute after start, then every 6 hours. */
export function scheduleUpdateChecks(): void {
  if (!isManaged()) return
  const tick = () => { void checkForUpdate() }
  setTimeout(tick, FIRST_CHECK_DELAY_MS).unref()
  setInterval(tick, CHECK_INTERVAL_MS).unref()
}
