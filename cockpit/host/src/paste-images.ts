import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type * as http from 'node:http'
import { COCKPIT_HOME } from './paths.js'

/**
 * Image paste for the terminal (POST /api/paste-image). A terminal only
 * carries bytes, so the frontend uploads a clipboard image here, the host
 * stores it and returns the absolute path, and the frontend types that path
 * into the session — Claude Code attaches an image given by path.
 *
 * The body is the raw image (Content-Type image/*), no multipart, so no
 * upload dependency. Files live in <home>/paste-images (owner-only) and are
 * pruned after a day on the next paste; the path only has to survive until
 * Claude reads it on send.
 */

export const PASTE_IMAGES_DIR = path.join(COCKPIT_HOME, 'paste-images')

const MAX_BYTES = 10 * 1024 * 1024
const MAX_AGE_MS = 24 * 60 * 60 * 1000
const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

export class PasteImageError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

// Oversized bodies are drained and dropped, not cut off, so the client gets
// a clean 413 instead of a reset connection.
function readCapped(req: http.IncomingMessage): Promise<Buffer> {
  const tooLarge = () => new PasteImageError(413, 'Image larger than 10 MB')
  if (Number(req.headers['content-length']) > MAX_BYTES) {
    req.resume()
    return Promise.reject(tooLarge())
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size <= MAX_BYTES) chunks.push(chunk)
    })
    req.on('end', () => (size > MAX_BYTES ? reject(tooLarge()) : resolve(Buffer.concat(chunks))))
    req.on('error', reject)
  })
}

function pruneOld(keep: string): void {
  const now = Date.now()
  for (const name of fs.readdirSync(PASTE_IMAGES_DIR)) {
    if (name === keep) continue
    const file = path.join(PASTE_IMAGES_DIR, name)
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.unlinkSync(file)
    } catch { /* vanished mid-scan */ }
  }
}

/** Store the request's image body; returns the absolute file path. */
export async function savePastedImage(req: http.IncomingMessage): Promise<string> {
  const mime = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
  const ext = EXTENSIONS[mime]
  if (!ext) throw new PasteImageError(415, 'Unsupported image type')
  const body = await readCapped(req)
  if (!body.length) throw new PasteImageError(400, 'No image provided')

  fs.mkdirSync(PASTE_IMAGES_DIR, { recursive: true, mode: 0o700 })
  const name = `${randomUUID()}.${ext}`
  const file = path.join(PASTE_IMAGES_DIR, name)
  fs.writeFileSync(file, body, { mode: 0o600 })
  try { pruneOld(name) } catch { /* best effort */ }
  return file
}
