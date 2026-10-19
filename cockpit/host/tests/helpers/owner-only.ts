import { statSync } from 'node:fs'
import { expect } from 'vitest'

/**
 * The file is readable by its owner only (mode 600). Windows has no POSIX
 * modes (every file reads 0o666) — there the user profile's ACL keeps it
 * private, so the check applies on macOS and Linux.
 */
export function expectOwnerOnly(file: string): void {
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
}
