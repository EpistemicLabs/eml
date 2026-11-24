import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type * as http from 'node:http'

import { extensionOf, extractFileRefs, fileKind, MEDIA_TYPE_BY_EXT, type FileKind } from './domain/file-refs.js'

/**
 * The media viewer's host side (decision cockpit-media-viewer-v3): a file an agent names in a chat
 * shows in the cockpit, from any folder on this machine, not only the session's workspace.
 *
 * - GET  /api/file?path=<absolute path>: the file's bytes, for the viewers (image, PDF, CSV, Markdown).
 * - POST /api/files/stat { refs, sessionId? }: which of the paths a message names are files the
 *   viewer shows; a relative one is read from the session's folder.
 * - GET  /api/files/recent: the files named in recent chats, for ⌘K, each with its chat.
 *
 * Guard: the host's request gate already lets in only this machine and the tailnet users remote
 * access lists. Since any path can be asked for, the file route also answers only the cockpit's
 * own page: a request another site's page makes (an <img> or <iframe> pointing here) carries
 * Sec-Fetch-Site cross-site and is refused, as is one without the header. A served file never runs
 * as a page of the cockpit's origin: everything but a PDF carries a sandbox CSP, and only the
 * viewer's own types are served under their type (anything else downloads).
 */

export interface FileInfo {
  /** The text as the message names it. */
  ref: string
  /** The absolute, resolved path the host serves. */
  path: string
  name: string
  kind: FileKind
  size: number
  modifiedAt: string
}

export interface RecentFile extends FileInfo {
  sessionId: string
  sessionTitle: string
  projectId: string | null
  spaceId: string | null
  /** When the chat that names it was last active. */
  seenAt: string
}

export interface RecentSession {
  sessionId: string
  title: string
  projectId: string | null
  spaceId: string | null
  lastActivity: string
}

export interface FilesDeps {
  /** The folder a session runs in, for its relative paths; null when unknown. */
  cwdOf(sessionId: string): string | null
  /** Sessions with recent activity, newest first. */
  recentSessions(): RecentSession[]
  /** The agent's reply texts in a session's transcript; null when it can't be read. */
  replyTexts(sessionId: string): Promise<string[] | null>
}

type Json = (res: http.ServerResponse, status: number, payload: unknown) => void
type ReadJson = (req: http.IncomingMessage) => Promise<Record<string, unknown>>

const MAX_REFS = 50
const RECENT_DAYS = 14
const RECENT_SESSIONS = 40
const RECENT_FILES = 200

/** A path as a message names it, made absolute: ~ from the home folder, a relative one from cwd. */
export function resolveRef(ref: string, cwd: string | null): string | null {
  if (ref.startsWith('~/')) return path.join(os.homedir(), ref.slice(2))
  if (path.isAbsolute(ref)) return path.normalize(ref)
  return cwd ? path.resolve(cwd, ref) : null
}

/** The file behind a path when the viewer shows it: a regular file of a known kind. */
export function statFile(ref: string, cwd: string | null): FileInfo | null {
  const resolved = resolveRef(ref, cwd)
  if (!resolved) return null
  const kind = fileKind(resolved)
  if (!kind) return null
  try {
    const real = fs.realpathSync(resolved)
    const stat = fs.statSync(real)
    if (!stat.isFile()) return null
    return { ref, path: resolved, name: path.basename(resolved), kind, size: stat.size, modifiedAt: stat.mtime.toISOString() }
  } catch {
    return null
  }
}

/** Only the cockpit's own page may read files: same-origin fetches, or the user opening the URL. */
export function fileRequestAllowed(req: http.IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  return site === 'same-origin' || site === 'none'
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, json: Json, raw: string | null): void {
  if (!fileRequestAllowed(req)) {
    json(res, 403, { error: { code: 'FORBIDDEN', message: 'Files open only inside the cockpit' } })
    return
  }
  if (!raw || !path.isAbsolute(raw)) {
    json(res, 400, { error: { code: 'BAD_PATH', message: 'An absolute file path is needed' } })
    return
  }
  let real: string
  let stat: fs.Stats
  try {
    real = fs.realpathSync(raw)
    stat = fs.statSync(real)
  } catch {
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'That file is not there (anymore)' } })
    return
  }
  if (!stat.isFile()) {
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not a file' } })
    return
  }
  const ext = extensionOf(raw)
  const known = MEDIA_TYPE_BY_EXT[ext]
  const headers: Record<string, string | number> = {
    'Content-Type': known ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache',
    'Last-Modified': stat.mtime.toUTCString(),
    // A PDF opens in the browser's own viewer, which a sandboxed document is not allowed to load.
    ...(ext === 'pdf' ? {} : { 'Content-Security-Policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'" }),
    ...(known ? {} : { 'Content-Disposition': `attachment; filename="${path.basename(raw).replace(/["\\\r\n]/g, '_')}"` }),
  }
  const since = req.headers['if-modified-since']
  if (since && !Number.isNaN(Date.parse(since)) && Math.floor(stat.mtimeMs / 1000) <= Math.floor(Date.parse(since) / 1000)) {
    res.writeHead(304, { 'Cache-Control': 'no-cache', 'Last-Modified': headers['Last-Modified'] as string })
    res.end()
    return
  }
  res.writeHead(200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  const stream = fs.createReadStream(real)
  stream.on('error', () => res.destroy())
  stream.pipe(res)
}

/** The files a session's replies name, newest first, each once. */
export async function filesOfSession(deps: FilesDeps, session: RecentSession): Promise<RecentFile[]> {
  const texts = await deps.replyTexts(session.sessionId)
  if (!texts) return []
  const cwd = deps.cwdOf(session.sessionId)
  const files: RecentFile[] = []
  const seen = new Set<string>()
  for (const text of [...texts].reverse()) {
    for (const ref of extractFileRefs(text)) {
      const info = statFile(ref, cwd)
      if (!info || seen.has(info.path)) continue
      seen.add(info.path)
      files.push({ ...info, sessionId: session.sessionId, sessionTitle: session.title, projectId: session.projectId, spaceId: session.spaceId, seenAt: session.lastActivity })
    }
  }
  return files
}

/** Recent files, cached per session until its chat moves on. */
export function createRecentFiles(deps: FilesDeps) {
  const cache = new Map<string, { lastActivity: string; files: RecentFile[] }>()
  return async function recentFiles(): Promise<RecentFile[]> {
    const since = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000
    const sessions = deps.recentSessions()
      .filter((s) => Date.parse(s.lastActivity) >= since)
      .slice(0, RECENT_SESSIONS)
    const all: RecentFile[] = []
    for (const session of sessions) {
      const cached = cache.get(session.sessionId)
      let files: RecentFile[]
      if (cached && cached.lastActivity === session.lastActivity) files = cached.files.map((f) => ({ ...f, sessionTitle: session.title }))
      else {
        files = await filesOfSession(deps, session).catch(() => [])
        cache.set(session.sessionId, { lastActivity: session.lastActivity, files })
      }
      all.push(...files)
    }
    // The newest mention wins when two chats name the same file.
    const seen = new Set<string>()
    return all.filter((f) => (seen.has(f.path) ? false : (seen.add(f.path), true))).slice(0, RECENT_FILES)
  }
}

export async function handleFilesApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: FilesDeps,
  recent: () => Promise<RecentFile[]>,
  url: URL,
  method: string,
  json: Json,
  readJson: ReadJson,
): Promise<boolean> {
  if (url.pathname === '/api/file' && (method === 'GET' || method === 'HEAD')) {
    serveFile(req, res, json, url.searchParams.get('path'))
    return true
  }
  if (url.pathname === '/api/files/stat' && method === 'POST') {
    const body = await readJson(req)
    const refs = Array.isArray(body.refs) ? body.refs.filter((r): r is string => typeof r === 'string' && r.length > 0 && r.length < 4096).slice(0, MAX_REFS) : []
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null
    const cwd = sessionId ? deps.cwdOf(sessionId) : null
    json(res, 200, { files: refs.map((ref) => statFile(ref, cwd)).filter((f): f is FileInfo => f !== null) })
    return true
  }
  if (url.pathname === '/api/files/recent' && method === 'GET') {
    json(res, 200, { files: await recent() })
    return true
  }
  return false
}
