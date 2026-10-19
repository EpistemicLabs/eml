import * as fs from 'node:fs'

/**
 * Windows keeps a file locked for a moment after a process used it (a binary
 * the self-test just ran, files npm just wrote, a virus scanner still reading
 * them): renaming or deleting it then fails with EBUSY or EPERM. Retried with
 * a backoff, as rimraf and graceful-fs do; elsewhere the first try succeeds.
 */
export const FS_RETRY = { maxRetries: 10, retryDelay: 100 }
const RETRYABLE = new Set(['EBUSY', 'EPERM', 'EACCES'])

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to)
      return
    } catch (e) {
      if (attempt >= FS_RETRY.maxRetries || !RETRYABLE.has((e as NodeJS.ErrnoException).code ?? '')) throw e
      await new Promise((resolve) => setTimeout(resolve, FS_RETRY.retryDelay * (attempt + 1)))
    }
  }
}
