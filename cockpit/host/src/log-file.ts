import * as fs from 'node:fs'

/**
 * A host started without a console (the Windows autostart supervisor runs it
 * hidden) names its log file in COCKPIT_LOG_FILE: everything the host and its
 * brain server print goes there, appended. launchd redirects by itself and
 * sets no such variable.
 *
 * Runs when imported: index.ts imports this module first, so even an error
 * while the other modules load lands in the log.
 */
function logToFileIfAsked(): void {
  const file = process.env.COCKPIT_LOG_FILE
  if (!file) return
  const fd = fs.openSync(file, 'a')
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: string | Uint8Array, encoding?: unknown, cb?: unknown) => {
      const done = typeof encoding === 'function' ? encoding : cb
      try { fs.writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk) } catch { /* the log is best-effort */ }
      if (typeof done === 'function') (done as () => void)()
      return true
    }) as typeof stream.write
  }
}

logToFileIfAsked()
