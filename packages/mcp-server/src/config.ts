import * as fs from 'fs'
import * as path from 'path'

// The EML client config the hooks read: key=value lines with the server URL
// and the token. Embedding apps (the EML cockpit) write it
// and pass its path via `hook … --config <path>`; ~/.eml/config is the default.

export const HOME_DIR = process.env.HOME || process.env.USERPROFILE || ''
export const EML_DIR = path.join(HOME_DIR, '.eml')
export const EML_CONFIG = path.join(EML_DIR, 'config')

export interface EmlConfig {
  EML_URL?: string
  EML_API_TOKEN?: string
}

export function readConfig(configPath: string = EML_CONFIG): EmlConfig | null {
  if (!fs.existsSync(configPath)) return null
  return parseConfig(fs.readFileSync(configPath, 'utf-8'))
}

/** Parse config text as DATA (key=value lines, known keys only) — never evaluate it. */
export function parseConfig(raw: string): EmlConfig {
  const out: EmlConfig = {}
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 0) continue
    const key = trimmed.slice(0, eq).trim()
    const value = trimmed.slice(eq + 1).trim()
    if (key === 'EML_URL' || key === 'EML_API_TOKEN') {
      out[key] = value
    }
  }
  return out
}
