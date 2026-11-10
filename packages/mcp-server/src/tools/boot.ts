import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EmlApi } from '../http-client'
import { callTool } from './_helpers'

export function registerBootTool(server: McpServer, http: EmlApi): void {
  server.registerTool(
    'eml_boot',
    {
      title: 'Boot Brain',
      description:
        'Reloads this session\'s boot: your agent block (persona, the people you work with, your rules) and the ' +
        'system rules — the same markdown the SessionStart hook delivers. Rarely needed (the hook fires ' +
        'automatically); use only after a major mid-session change to your identity or a suspected incomplete ' +
        'boot. For "refresh my memory" use eml_recall / eml_show — boot is identity, not topic lookup.',
      // No agent parameter: outside the cockpit the boot is the brain's default agent; in the cockpit it is the
      // session's agent, and another agent's brain is not readable from a session (the routing refuses it).
      inputSchema: z.object({}).strict(),
    },
    async () => callTool(() => http.post('/boot', {})),
  )
}
