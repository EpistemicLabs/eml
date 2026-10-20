import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

/**
 * v0.9 Cluster 4 step 3: brain state for an arbitrary scope.
 *
 * Works for `global`, `project.X`, `entity.X`, `agent.X`, `user.X`.
 * Returns a curated snapshot: current_status, open_tasks, recent_decisions,
 * recent_logs, rules.
 */
export function registerShowTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_show',
    {
      title: 'Show BrainState for Scope',
      description:
        'Curated snapshot for one scope: the status (with what it tracks), open tasks, recent ' +
        'decisions, the latest session log with its next steps, active rules (situational ones with ' +
        'their trigger), ripe learnings, plus the project\'s or entity\'s metadata. ' +
        'The "where do we stand?" tool when you know the exact scope. For fuzzy/cross-scope search use ' +
        'eml_recall; for filtered enumeration use eml_list; for one engram use eml_get. Relations are ' +
        'not included — fetch via eml_get(with_relations).',
      inputSchema: z.object({
        scope: z.string().describe(
          'global | project.<id> | entity.<id> | agent.<id> | user.<id>.',
        ),
      }).strict(),
    },
    async (args) => callTool(() => http.get('/brain-state', { scope: args.scope })),
  )
}
