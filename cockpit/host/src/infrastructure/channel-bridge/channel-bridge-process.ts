import { spawn as spawnProcess } from 'node:child_process'
import type { EventEmitter } from 'node:events'
import { failuresAfterExit, restartDelay } from '../../domain/child-restart.js'

export interface ChannelBridgeSettings {
  /** The bundled bridge (dist/channel-bridge.cjs). */
  script: string
  home: string
  port: number
  cockpitUrl: string
  tokensDir: string
  accountsFile: string
  /** Preload that ends the bridge once the host is gone (brain-watchdog.ts), when built. */
  watchdog?: string
}

/** The part of a child process the supervisor uses. */
export interface BridgeChild extends EventEmitter {
  readonly stdout: EventEmitter | null
  readonly stderr: EventEmitter | null
  kill(signal: NodeJS.Signals): boolean
}

export interface SuperviseDeps {
  spawn: (args: string[], env: Record<string, string | undefined>) => BridgeChild
  log: (line: string) => void
}

export const defaultSpawn: SuperviseDeps['spawn'] = (args, env) =>
  spawnProcess('node', args, { env, stdio: ['pipe', 'pipe', 'pipe'] })

/**
 * Runs the channel bridge next to the host: started with its settings, started again after a crash
 * with a growing wait, stopped with the host. Its stdin stays a pipe, so the watchdog preload ends
 * it when the host dies without stopping it.
 */
export function superviseChannelBridge(settings: ChannelBridgeSettings, deps: SuperviseDeps): { url: string; stop(): void } {
  const env = {
    ...process.env,
    CHANNEL_BRIDGE_HOME: settings.home,
    CHANNEL_BRIDGE_PORT: String(settings.port),
    COCKPIT_URL: settings.cockpitUrl,
    COCKPIT_JOB_TOKENS_DIR: settings.tokensDir,
    CHANNEL_BRIDGE_ACCOUNTS_FILE: settings.accountsFile,
  }
  const args = [...(settings.watchdog ? ['--import', settings.watchdog] : []), settings.script]
  let child: BridgeChild | null = null
  let stopped = false
  let failures = 0
  let timer: NodeJS.Timeout | null = null

  const start = (): void => {
    const startedAt = Date.now()
    const current = deps.spawn(args, env)
    child = current
    current.stdout?.on('data', (data: Buffer) => forward(deps.log, '[bridge]', data))
    current.stderr?.on('data', (data: Buffer) => forward(deps.log, '[bridge!]', data))
    current.on('error', (err: Error) => deps.log(`[bridge!] could not run: ${err.message}`))
    current.on('exit', (code: number | null, signal: string | null) => {
      if (child === current) child = null
      if (stopped) return
      failures = failuresAfterExit(failures, Date.now() - startedAt)
      const wait = restartDelay(failures)
      deps.log(`[bridge] exited (code ${code ?? '-'}, signal ${signal ?? '-'}); restart in ${wait} ms`)
      timer = setTimeout(start, wait)
    })
  }
  start()

  return {
    url: `http://127.0.0.1:${settings.port}`,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
      child?.kill('SIGTERM')
    },
  }
}

function forward(log: (line: string) => void, prefix: string, data: Buffer): void {
  for (const line of String(data).split('\n')) if (line.trim()) log(`${prefix} ${line}`)
}
