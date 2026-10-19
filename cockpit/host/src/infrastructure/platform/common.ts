import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import type { Platform } from '../../domain/platform.js'

/** Helpers the adapters share; posixBase is what macOS and Linux have in common. */

export const archKey = (): 'arm64' | 'x64' => {
  if (process.arch === 'arm64' || process.arch === 'x64') return process.arch
  throw new Error(`unsupported architecture: ${process.arch}`)
}

export const runFile = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => {
  execFile(cmd, args, (err) => (err ? reject(err) : resolve()))
})

export const detached = (cmd: string, args: string[]) => {
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref() } catch { /* headless */ }
}

export const posixBase: Pick<Platform, 'exe' | 'sessionEnvKeys'> = {
  exe: (name) => name,
  sessionEnvKeys: [],
}

export const isMuslLinux = (): boolean => {
  try { return fs.readdirSync('/lib').some((n) => n.startsWith('ld-musl')) } catch { return false }
}
