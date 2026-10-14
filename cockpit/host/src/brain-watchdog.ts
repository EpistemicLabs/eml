/**
 * Preloaded into the brain server by the host (`node --import <this> server.cjs`).
 * The host holds the other end of the server's stdin. When the host is gone —
 * clean exit, crash, SIGKILL, a tsx-watch restart — the OS closes that pipe, and
 * the server shuts down through its own SIGTERM handler (pool drain, WAL
 * checkpoint) instead of living on as an orphan that keeps the brain DB open.
 */
const stop = () => process.kill(process.pid, 'SIGTERM')
process.stdin.on('end', stop)
process.stdin.on('error', stop)
process.stdin.resume()

export {}
