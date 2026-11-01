import { randomBytes } from 'node:crypto'
import * as fs from 'node:fs'

/**
 * The token an outside service on this machine holds to send wakeable sessions
 * messages. Sessions get a per-boot token in their environment; a service outlives
 * the host, so this one stays, in an owner-only file the service reads.
 */
export function loadMessageToken(file: string): string {
  try {
    const token = fs.readFileSync(file, 'utf8').trim()
    if (token) return token
  } catch { /* first start */ }
  const token = randomBytes(24).toString('hex')
  fs.writeFileSync(file, token, { mode: 0o600 })
  return token
}
