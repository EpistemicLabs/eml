/**
 * cockpit-diagnose — the cockpit's diagnostics (diagnostics/diagnose.ts) from
 * inside a cockpit session, for the report-issue skill:
 *
 *   node "$COCKPIT_DIAGNOSE_JS"
 *
 * A session does not carry EML_COCKPIT_HOME or COCKPIT_PORT (a dev cockpit
 * started from a session must not pick up the production home), so this reads
 * the home from COCKPIT_HOME and the port from COCKPIT_URL, which the host puts
 * into every session's env, before the modules that resolve them load.
 */
if (!process.env.EML_COCKPIT_HOME && process.env.COCKPIT_HOME) process.env.EML_COCKPIT_HOME = process.env.COCKPIT_HOME
if (!process.env.COCKPIT_PORT && process.env.COCKPIT_URL) {
  const port = new URL(process.env.COCKPIT_URL).port
  if (port) process.env.COCKPIT_PORT = port
}

const { diagnose } = await import('./diagnostics/diagnose.js')
process.stdout.write(`${await diagnose()}\n`)
