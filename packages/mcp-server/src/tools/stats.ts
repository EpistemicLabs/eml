import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

/**
 * v0.9 Cluster 4 step 3: brain self-awareness — counts per type/scope plus
 * container counts (agents/projects/users).
 *
 * Useful for quick "what does the brain look like" — e.g. after migrations,
 * before strategic decisions, or as an onboarding sanity check.
 */
export function registerStatsTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_stats',
    {
      title: 'Brain Stats',
      description:
        'Brain self-awareness: total engrams, counts per type and per scope, plus ' +
        'agent/project/user inventory. No filter — whole-brain snapshot, for audits, ' +
        'migration verification, and spotting type-imbalance (e.g. log spam). For actual ' +
        'engrams use eml_list; for one scope\'s state use eml_show.',
      inputSchema: z.object({}).strict(),
    },
    async () => callTool(() => http.get('/stats')),
  )
}
