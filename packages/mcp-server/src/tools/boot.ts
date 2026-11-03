import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

export function registerBootTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_boot',
    {
      title: 'Boot Brain',
      description:
        'Manual brain-reload — returns the same identity + rules markdown the ' +
        'SessionStart-Hook already delivers at session start. Rarely needed (the hook ' +
        'fires automatically); use only after a major mid-session brain mutation, a ' +
        'suspected incomplete boot, or to inspect a different agent. For "refresh my ' +
        'memory" use eml_recall / eml_show — boot is identity, not topic lookup.',
      inputSchema: z.object({
        agent: z.string().optional().describe(
          'Agent ID. Omit for the brain default; set only to inspect a different agent.',
        ),
      }).strict(),
    },
    async (args) => callTool(() => http.post('/boot', { agent: args.agent })),
  )
}
