import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'

export function registerUpdateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_update',
    {
      title: 'Update Engram',
      description:
        'Patches an existing engram (status / significance / content / title / scope / ' +
        'properties) — the cleanup + supersession tool. Common: task done → {status: resolved, ' +
        'properties: {outcome: \'…\'}}; decision/reference replaced → {status: superseded} on the ' +
        'old one, then write the new; rule/profile refined → patch content. A task\'s progress or ' +
        'stage change → eml_task_entry, not a content patch.\n\n' +
        'Properties merge SHALLOWLY (incoming keys overwrite, others preserved); pass null to ' +
        'delete a key. patch.content REPLACES content wholesale — no partial merge. If unsure of ' +
        'the current state, eml_get(id) first.\n\n' +
        'Reviews: changing a decision, rule or profile (content, title, scope or properties) ' +
        'restarts its review and clears the review flag. If it still holds unchanged, confirm it ' +
        'with properties.review_note — why it still holds.',
      inputSchema: {
        id: z.string().describe('Engram UUID, from a recall / list / show / get result.'),
        patch: z.object({
          content: z.string().optional().describe('Wholesale replacement (no partial merge).'),
          status: z.enum(['planned', 'active', 'superseded', 'invalidated', 'expired', 'resolved']).optional().describe(
            'resolved = task done (a task needs properties.outcome) · superseded = replaced by a ' +
            'newer engram · invalidated = no longer applicable, no replacement (a task needs ' +
            'properties.outcome) · expired = past expires_at.',
          ),
          significance: z.enum(['critical', 'high', 'normal', 'low', 'trivial']).optional().describe(
            'Re-rank on new evidence.',
          ),
          title: z.string().optional().describe(
            'Rename the recall-anchor (sparingly — breaks title threads).',
          ),
          scope: z.string().optional().describe(
            'Reassign scope (e.g. saved global but really project-bound).',
          ),
          properties: z.record(z.string(), z.unknown()).optional().describe(
            'Shallow merge; null deletes a key.',
          ),
          tags: z.array(z.string()).optional().describe(
            'Registered tag ids; REPLACES the current set ([] clears).',
          ),
          subjects: z.array(z.string()).optional().describe(
            'Registered subject ids (eml_subjects); REPLACES the current set ([] clears).',
          ),
        }).describe('Only the fields to modify.'),
      },
    },
    async (args) => callTool(() => http.post('/update', args), { prefix: writeBanner }),
  )
}
