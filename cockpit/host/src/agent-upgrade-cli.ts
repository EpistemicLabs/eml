import * as net from 'node:net'
import { readCockpitConfig, writeCockpitConfig } from './config.js'
import { BACKUPS_DIR, DATA_DIR } from './paths.js'
import { dryRun, needsUpgrade, renderReport, upgradeHome } from './agent-upgrade.js'
import * as path from 'node:path'
import * as fs from 'node:fs'

/**
 * `eml-cockpit upgrade-agents [--run] [--handle <handle>] [--agents <id,…>]`:
 * the agent upgrade by hand (agent-upgrade.ts), on the home EML_COCKPIT_HOME
 * names. Without --run it is a dry run on copies and prints what the real
 * run would do; --run does what the host does at start — dry run, then the
 * real run when every check passed — and writes the config. The host must be
 * down: the brain server would otherwise hold the files a run rewrites.
 */

const PORT = Number(process.env.COCKPIT_PORT) || 4317

function portResponds(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => { sock.destroy(); resolve(true) })
    sock.once('error', () => resolve(false))
  })
}

function option(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

export async function runUpgradeAgentsCommand(argv: string[]): Promise<boolean> {
  if (argv[0] !== 'upgrade-agents') return false
  const run = argv.includes('--run')
  const handle = option(argv, '--handle')
  const agents = option(argv, '--agents')?.split(',').map((s) => s.trim()).filter(Boolean)
  const config = await readCockpitConfig()
  if (!config) throw new Error('no cockpit config — this home is not set up')
  if (run && await portResponds(PORT)) throw new Error(`the cockpit host answers on port ${PORT} — stop it first (the upgrade rewrites brain files)`)
  if (!needsUpgrade(config)) { process.stdout.write('every space is bound to an agent — nothing to do\n'); return true }
  if (!run) {
    const dir = path.join(BACKUPS_DIR, 'agent-upgrade', `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')}-dry`)
    const report = await dryRun({ dataDir: DATA_DIR, config, dir, handle, agents })
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(dir, 'dry-run.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
    process.stdout.write(`${renderReport(report)}\nreport: ${path.join(dir, 'dry-run.json')}\n(dry run on copies — the home is unchanged; --run applies it)\n`)
    return true
  }
  const { report, dir } = await upgradeHome({
    dataDir: DATA_DIR, config, handle, agents, backupsDir: BACKUPS_DIR,
    writeConfig: (next) => writeCockpitConfig(next),
    log: (line) => process.stderr.write(`${line}\n`),
  })
  process.stdout.write(`${renderReport(report)}\nreports and backups: ${dir}\n`)
  return true
}
