import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

const TASK_STAGES = ['ideation', 'planning', 'ready', 'implementation'] as const

/**
 * v0.15: append-only journal entry on a task (POST /task/:id/entry).
 *
 * A separate tool, not a mode of eml_track_task: task_id is required and the
 * tool cannot create anything, so a forgotten id fails instead of silently
 * creating a duplicate task (spec decision 15, rule eml-fail-over-inflate).
 */
export function registerTaskEntryTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_task_entry',
    {
      title: 'Task Entry',
      description:
        'Appends an entry to a task\'s journal: progress, a step back, a hand-off note. ' +
        'Append-only, stamped with time and author — safe when several sessions work in ' +
        'parallel. Shown with the task on eml_get. Use instead of rewriting the task\'s content ' +
        'or adding dated properties. Changing stage? Pass stage — it is set on the task and ' +
        'recorded in the entry.',
      inputSchema: {
        task_id: z.string().describe('Id of the task (full id).'),
        text: z.string().describe('1-3 sentences, what happened and what\'s next.'),
        stage: z.enum(TASK_STAGES).optional().describe(
          'How mature the work is: ideation (noted) · planning (options being weighed) · ready ' +
          '(decided: decisions + plan settled) · implementation (being built). Optional; frozen when the task closes.',
        ),
      },
    },
    async (args) => callTool(() =>
      http.post(`/task/${encodeURIComponent(args.task_id)}/entry`, { text: args.text, stage: args.stage }),
    ),
  )
}
