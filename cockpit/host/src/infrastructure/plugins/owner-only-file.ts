import { promises as fs } from 'node:fs'
import * as path from 'node:path'

/**
 * Writes a file readable by its owner only, atomically: a temporary file next to it, then a rename.
 * With `lockDir` the folder is made owner-only too (the cockpit's own folders); a folder another
 * program owns (Claude Code's config folder) is left as it is.
 */
export async function writeOwnerOnly(file: string, text: string, options: { lockDir?: boolean } = {}): Promise<void> {
  const lockDir = options.lockDir ?? true
  await fs.mkdir(path.dirname(file), { recursive: true, ...(lockDir ? { mode: 0o700 } : {}) })
  if (lockDir) await fs.chmod(path.dirname(file), 0o700)
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.rename(tmp, file)
}

/** Runs writes one at a time, in the order they were asked for; one that fails doesn't stop the next. */
export class WriteQueue {
  private last: Promise<unknown> = Promise.resolve()

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.last.then(work, work)
    this.last = next.catch(() => undefined)
    return next
  }
}
