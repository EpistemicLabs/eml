import type * as http from 'node:http'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { defaultBranch, gitRunner, notFound, parseWorktrees, type Git, type Json, type PluginsApiDeps } from './plugins-api.js'

/**
 * The Repository plugin (task cockpit-plugin-changes): a read-only code view of a
 * project's checkouts — what changed, the whole tree, the commits.
 *
 *   GET /api/plugins/repository/repo?projectId=        → the checkouts to pick from
 *   GET /api/plugins/repository/files?…&scope=&commit= → the changed files of a diff
 *   GET /api/plugins/repository/patch?…&path=          → one file's patch
 *   GET /api/plugins/repository/commits?…              → the branch's commits
 *   GET /api/plugins/repository/tree?…                 → every file of the checkout
 *   GET /api/plugins/repository/dir?…&path=            → one folder's entries
 *   GET /api/plugins/repository/file?…&path=           → one file's content
 *
 * Every route but repo takes projectId and worktree. The folder comes from the
 * project registry, a worktree must be one of its `git worktree list` (or the
 * folder itself when it is no repository), and a path must lie inside the
 * checkout after symlinks are resolved: a caller can't read beyond them. A
 * file that looks like it holds secrets (.env, keys) is shown only on reveal=1.
 * git runs without external diff tools and textconv filters: a repository's
 * own config can't make a read run a program.
 */

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
/** Beyond these the view says it stops: files of a diff, paths of a tree, lines of a patch, entries of a folder. */
const MAX_FILES = 1000
const MAX_PATHS = 50_000
const MAX_PATCH_LINES = 3000
const MAX_ENTRIES = 2000
/** A larger file is not shown, only named. */
const MAX_FILE_BYTES = 1024 * 1024
const DIFF = ['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M']

export interface FileChange {
  path: string
  /** The path before a rename. */
  oldPath: string | null
  /** A added · M modified · D deleted · R renamed · C copied · T type changed · ? untracked */
  status: string
  /** null: a binary file, or an untracked one too large to count. */
  additions: number | null
  deletions: number | null
}

export interface RepositoryCommit {
  hash: string
  subject: string
  author: string
  at: string
}

type Scope = { kind: 'uncommitted' } | { kind: 'branch' } | { kind: 'commit'; sha: string }

interface Checkout {
  root: string
  /** false: a plain folder — no diffs or commits, only its files. */
  git: boolean
}

const badRequest = (json: Json, res: http.ServerResponse, message: string) =>
  json(res, 400, { error: { code: 'BAD_REQUEST', message } })

export async function handleRepositoryApi(res: http.ServerResponse, deps: PluginsApiDeps, url: URL, json: Json): Promise<boolean> {
  const git = deps.git ?? gitRunner(32 * 1024 * 1024)
  const what = url.pathname.slice('/api/plugins/repository/'.length)
  const param = (name: string) => url.searchParams.get(name) ?? ''
  const folder = deps.projectFolder(param('projectId'))
  if (!folder) {
    notFound(json, res, 'This project has no folder')
    return true
  }
  if (what === 'repo') {
    json(res, 200, await checkouts(folder, git))
    return true
  }
  const checkout = await resolveCheckout(folder, param('worktree') || null, git)
  if (!checkout) {
    notFound(json, res, 'No such checkout of this project')
    return true
  }
  const { root } = checkout
  const relPath = param('path')
  const reveal = param('reveal') === '1'

  if (what === 'dir') {
    const dir = await insideRoot(root, relPath || '.')
    if (!dir) {
      notFound(json, res, 'No such folder in this checkout')
      return true
    }
    json(res, 200, await listDir(dir))
    return true
  }
  if (what === 'file') {
    const file = relPath && await checkoutFile(root, relPath)
    if (!file) {
      notFound(json, res, 'No such file in this checkout')
      return true
    }
    json(res, 200, await readFile(file, relPath, reveal))
    return true
  }
  if (!checkout.git) {
    notFound(json, res, 'The project folder is no git repository')
    return true
  }
  if (what === 'tree') {
    json(res, 200, await tree(root, git))
    return true
  }
  if (what === 'commits') {
    json(res, 200, await commits(root, git))
    return true
  }
  const scope = parseScope(param('scope'), param('commit'))
  if (!scope) {
    badRequest(json, res, 'scope is uncommitted, branch or commit (with commit=<sha>)')
    return true
  }
  const range = await diffRange(root, scope, git)
  if (!range) {
    notFound(json, res, scope.kind === 'branch' ? 'No default branch to compare with' : 'No such commit')
    return true
  }
  if (what === 'files') {
    json(res, 200, await changedFiles(root, range, scope.kind === 'uncommitted', git))
    return true
  }
  if (what === 'patch') {
    const oldPath = param('oldPath')
    if (!relPath || !staysInside(relPath) || (oldPath && !staysInside(oldPath))) {
      badRequest(json, res, 'path is a path inside the checkout')
      return true
    }
    if (isSecretPath(relPath) && !reveal) {
      json(res, 200, { patch: null, truncated: false, secret: true })
      return true
    }
    if (param('status') === '?' && scope.kind === 'uncommitted') {
      const file = await checkoutFile(root, relPath)
      if (file && isSecretPath(file) && !reveal) json(res, 200, { patch: null, truncated: false, secret: true })
      else json(res, 200, file ? await untrackedPatch(file) : { patch: null, truncated: false, secret: false })
      return true
    }
    const out = await git(root, [...DIFF, ...range, '--', `:(literal)${relPath}`, ...(oldPath ? [`:(literal)${oldPath}`] : [])])
    json(res, 200, { ...capLines(out ?? ''), secret: false })
    return true
  }
  return false
}

/** The project folder's checkouts: the main one and every worktree, or the folder alone without git. */
async function checkouts(folder: string, git: Git) {
  const list = await git(folder, ['worktree', 'list', '--porcelain'])
  if (list === null) return { folder: path.resolve(folder), base: null, worktrees: null }
  const top = (await git(folder, ['rev-parse', '--show-toplevel']))?.trim()
  const projectRoot = path.resolve(top || folder)
  return {
    folder: projectRoot,
    base: await defaultBranch(folder, git),
    worktrees: parseWorktrees(list).map((wt) => ({ ...wt, isProjectFolder: wt.path === projectRoot })),
  }
}

/** The checkout a request names; none named → the project's own. */
export async function resolveCheckout(folder: string, worktree: string | null, git: Git): Promise<Checkout | null> {
  const list = await git(folder, ['worktree', 'list', '--porcelain'])
  if (list === null) {
    const root = path.resolve(folder)
    return !worktree || path.resolve(worktree) === root ? { root, git: false } : null
  }
  if (!worktree) {
    const top = (await git(folder, ['rev-parse', '--show-toplevel']))?.trim()
    return { root: path.resolve(top || folder), git: true }
  }
  const wanted = path.resolve(worktree)
  return parseWorktrees(list).some((wt) => wt.path === wanted) ? { root: wanted, git: true } : null
}

/** The real path of `rel` when it exists and lies inside `root`, symlinks resolved; else null. */
export async function insideRoot(root: string, rel: string): Promise<string | null> {
  if (path.isAbsolute(rel)) return null
  try {
    const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(path.resolve(root, rel))])
    return within(realRoot, real) ? real : null
  } catch {
    return null
  }
}

/**
 * A file of the checkout the view may read: inside it (insideRoot), and not
 * in a .git folder — its config can hold a token in a remote URL.
 */
async function checkoutFile(root: string, rel: string): Promise<string | null> {
  const real = await insideRoot(root, rel)
  if (!real) return null
  const inside = path.relative(await fs.realpath(root), real)
  return inside.split(path.sep).includes('.git') ? null : real
}

const within = (root: string, target: string) => {
  const rel = path.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** A path for git to read: relative and not climbing out (the file itself may be gone). */
const staysInside = (rel: string) => !path.isAbsolute(rel) && within('/r', path.posix.resolve('/r', rel.replace(/\\/g, '/')))

/** Files that usually hold credentials; templates (.env.example) don't. */
export function isSecretPath(rel: string): boolean {
  const name = path.basename(rel).toLowerCase()
  if (/^\.env(\..+)?$/.test(name)) return !/\.(example|sample|template|dist)$/.test(name)
  return /\.(pem|key|p12|pfx|jks|keystore)$/.test(name)
    || /^id_(rsa|dsa|ecdsa|ed25519)$/.test(name)
    || ['.npmrc', '.netrc', '.pgpass', 'credentials', 'credentials.json'].includes(name)
}

function parseScope(scope: string, commit: string): Scope | null {
  if (scope === 'uncommitted' || scope === 'branch') return { kind: scope }
  if (scope === 'commit' && /^[0-9a-f]{4,40}$/i.test(commit)) return { kind: 'commit', sha: commit }
  return null
}

/** The `git diff` arguments of a scope; null: nothing to compare with. */
async function diffRange(root: string, scope: Scope, git: Git): Promise<string[] | null> {
  const verify = (rev: string) => git(root, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  if (scope.kind === 'uncommitted') return [(await verify('HEAD')) === null ? EMPTY_TREE : 'HEAD']
  if (scope.kind === 'branch') {
    const base = await defaultBranch(root, git)
    return base && (await verify('HEAD')) !== null ? [`${base}...HEAD`] : null
  }
  if ((await verify(scope.sha)) === null) return null
  return [(await verify(`${scope.sha}^`)) === null ? EMPTY_TREE : `${scope.sha}^`, scope.sha]
}

async function changedFiles(root: string, range: string[], withUntracked: boolean, git: Git) {
  const [numstat, names, untracked] = await Promise.all([
    git(root, [...DIFF, '--numstat', '-z', ...range]),
    git(root, [...DIFF, '--name-status', '-z', ...range]),
    withUntracked ? git(root, ['ls-files', '-z', '--others', '--exclude-standard']) : Promise.resolve(''),
  ])
  const files = parseNameStatus(names ?? '')
  const counts = parseNumstat(numstat ?? '')
  for (const file of files) Object.assign(file, counts.get(file.path) ?? {})
  const added = (untracked ?? '').split('\0').filter(Boolean).slice(0, MAX_FILES)
  files.push(...await Promise.all(added.map(async (rel): Promise<FileChange> => ({
    path: rel, oldPath: null, status: '?', additions: await lineCount(path.join(root, rel)), deletions: 0,
  }))))
  files.sort((a, b) => a.path.localeCompare(b.path))
  return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES }
}

/** `--name-status -z`: the status, then the path — two paths after a rename or copy. */
export function parseNameStatus(output: string): FileChange[] {
  const tokens = output.split('\0')
  const files: FileChange[] = []
  for (let i = 0; i < tokens.length - 1;) {
    const status = tokens[i++]
    if (!status) continue
    const kind = status[0]
    const oldPath = kind === 'R' || kind === 'C' ? tokens[i++] : null
    files.push({ path: tokens[i++], oldPath, status: kind, additions: null, deletions: null })
  }
  return files
}

/** `--numstat -z`: `added\tdeleted\tpath`, or `added\tdeleted\t` and two paths after a rename; `-` for binary. */
export function parseNumstat(output: string): Map<string, Pick<FileChange, 'additions' | 'deletions'>> {
  const tokens = output.split('\0')
  const counts = new Map<string, Pick<FileChange, 'additions' | 'deletions'>>()
  for (let i = 0; i < tokens.length;) {
    const [added, deleted, rel] = tokens[i++].split('\t')
    if (deleted === undefined) continue
    const file = rel || (i++, tokens[i++])
    const count = (n: string) => (n === '-' ? null : Number(n))
    counts.set(file, { additions: count(added), deletions: count(deleted) })
  }
  return counts
}

/** The lines of a text file; null for a binary one or one too large to read. */
async function lineCount(file: string): Promise<number | null> {
  try {
    const stat = await fs.stat(file)
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null
    const buffer = await fs.readFile(file)
    if (isBinary(buffer)) return null
    const text = buffer.toString('utf8')
    return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
  } catch {
    return null
  }
}

const isBinary = (buffer: Buffer) => buffer.subarray(0, 8000).includes(0)

/** A new file's patch, as `git diff` would write it against nothing. */
async function untrackedPatch(file: string) {
  try {
    const stat = await fs.stat(file)
    if (stat.size > MAX_FILE_BYTES) return { patch: null, tooLarge: true, truncated: false, secret: false }
    const buffer = await fs.readFile(file)
    if (isBinary(buffer)) return { patch: 'Binary file', truncated: false, secret: false }
    const lines = buffer.toString('utf8').split('\n')
    if (lines.at(-1) === '') lines.pop()
    return { ...capLines(`@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join('\n')}\n`), secret: false }
  } catch {
    return { patch: null, truncated: false, secret: false }
  }
}

function capLines(patch: string) {
  const lines = patch.split('\n')
  if (lines.length <= MAX_PATCH_LINES) return { patch, truncated: false }
  return { patch: lines.slice(0, MAX_PATCH_LINES).join('\n'), truncated: true }
}

async function commits(root: string, git: Git) {
  const base = await defaultBranch(root, git)
  const format = '--format=%h%x00%s%x00%an%x00%cI'
  const ahead = base ? await git(root, ['log', '-200', format, `${base}..HEAD`]) : null
  // Nothing ahead (the default branch itself): its own history.
  const own = ahead?.trim() ? null : await git(root, ['log', '-50', format])
  const parse = (out: string): RepositoryCommit[] => out.split('\n').filter(Boolean).map((line) => {
    const [hash, subject, author, at] = line.split('\0')
    return { hash, subject: subject ?? '', author: author ?? '', at: at ?? '' }
  })
  return { base, onBranch: own === null, commits: parse(own ?? ahead ?? '') }
}

/** Every file of the checkout git doesn't ignore, and the ignored entries (folders whole). */
async function tree(root: string, git: Git) {
  const [files, ignored] = await Promise.all([
    git(root, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']),
    git(root, ['-c', 'core.quotePath=false', 'ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']),
  ])
  const paths = [...new Set((files ?? '').split('\0').filter(Boolean))]
  return {
    paths: paths.slice(0, MAX_PATHS),
    ignored: (ignored ?? '').split('\0').filter(Boolean).slice(0, MAX_PATHS),
    truncated: paths.length > MAX_PATHS,
  }
}

async function listDir(dir: string) {
  try {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const entries = dirents
      .filter((d) => d.name !== '.git')
      .map((d) => ({ name: d.name, dir: d.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
    return { entries: entries.slice(0, MAX_ENTRIES), truncated: entries.length > MAX_ENTRIES }
  } catch {
    return { entries: [], truncated: false }
  }
}

async function readFile(file: string, rel: string, reveal: boolean) {
  const stat = await fs.stat(file)
  // A link's name and its target's: notes.txt → .env is a secret too.
  const secret = isSecretPath(rel) || isSecretPath(file)
  const shown = { size: stat.size, secret, binary: false, tooLarge: false, content: null as string | null }
  if (!stat.isFile()) return shown
  if (stat.size > MAX_FILE_BYTES) return { ...shown, tooLarge: true }
  if (secret && !reveal) return shown
  const buffer = await fs.readFile(file)
  if (isBinary(buffer)) return { ...shown, binary: true }
  return { ...shown, content: buffer.toString('utf8') }
}
