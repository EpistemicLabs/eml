import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { McpServerSpec } from '../../domain/tool-profile.js'
import { BRAIN_WATCHDOG_JS, CHANNEL_BRIDGE_ACCOUNTS_FILE, CHANNEL_BRIDGE_HOME, CHANNEL_BRIDGE_JS, CHANNEL_BRIDGE_MCP_JS, JOB_TOKENS_DIR } from '../../paths.js'
import { getFreePort } from '../../ports.js'
import { defaultSpawn, superviseChannelBridge } from './channel-bridge-process.js'

/** The bridge's MCP server for one job's session: only paths and the job id, never a token. */
export function bridgeServerFor(jobId: string): Omit<McpServerSpec, 'type'> {
  return {
    command: process.execPath,
    args: [CHANNEL_BRIDGE_MCP_JS],
    env: {
      CHANNEL_BRIDGE_URL_FILE: path.join(CHANNEL_BRIDGE_HOME, 'url'),
      CHANNEL_BRIDGE_JOB_ID: jobId,
      CHANNEL_BRIDGE_TOOL_TOKEN_FILE: path.join(CHANNEL_BRIDGE_HOME, 'tool-token'),
    },
  }
}

/**
 * Starts the channel bridge next to the host, once its accounts file exists: without one there is
 * nothing to watch, and the bridge stays off.
 */
export async function startChannelBridge(cockpitUrl: string, log: (line: string) => void): Promise<{ stop(): void } | null> {
  if (!existsSync(CHANNEL_BRIDGE_ACCOUNTS_FILE)) return null
  if (!existsSync(CHANNEL_BRIDGE_JS)) {
    log(`[bridge] ${CHANNEL_BRIDGE_JS} missing — run the host build`)
    return null
  }
  const bridge = superviseChannelBridge(
    {
      script: CHANNEL_BRIDGE_JS,
      home: CHANNEL_BRIDGE_HOME,
      port: await getFreePort(),
      cockpitUrl,
      tokensDir: JOB_TOKENS_DIR,
      accountsFile: CHANNEL_BRIDGE_ACCOUNTS_FILE,
      ...(existsSync(BRAIN_WATCHDOG_JS) ? { watchdog: pathToFileURL(BRAIN_WATCHDOG_JS).href } : {}),
    },
    { spawn: defaultSpawn, log },
  )
  log(`[bridge] started at ${bridge.url}`)
  return bridge
}
