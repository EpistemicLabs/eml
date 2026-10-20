import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'
import { ENGRAM_TYPES } from './_shared'

export function registerListTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_list',
    {
      title: 'List Engrams',
      description:
        'Lists engrams by structured filters (type / scope / status / tag / subject / label / task_id …), with ' +
        'optional FTS5 `search` to narrow further. The way to reach non-active engrams ' +
        '(superseded / resolved / expired) and to run audit queries. For fuzzy topic ' +
        'search use eml_recall; for a one-scope dashboard use eml_show; for counts use ' +
        'eml_stats.',
      inputSchema: z.object({
        type: z.enum(ENGRAM_TYPES).optional().describe(
          'Engram type filter (task, decision, status, rule, event, …). Omit for all.',
        ),
        scope: z.string().optional().describe(
          'global | project.<id> | entity.<id> | agent.<id> | user.<id>. Omit for all.',
        ),
        title: z.string().optional().describe(
          'Exact title slug — traces one anchor across status changes.',
        ),
        status: z.enum(['planned', 'active', 'superseded', 'invalidated', 'expired', 'resolved']).optional().describe(
          'active (the usual; for a task = in progress — open tasks are planned + active) · ' +
          'superseded/invalidated/expired/resolved for audits.',
        ),
        assignee: z.string().optional().describe(
          'Filter tasks by assignee handle — an agent id (e.g. assistant) or a user/member handle ' +
          '(e.g. alice/bob). Matches properties.assignee_id exactly. E.g. find "alice\'s open ' +
          'tasks" → assignee=alice, type=task, then status planned and active.',
        ),
        tag: z.string().optional().describe(
          'Filter to engrams carrying this registered tag id (what they are ABOUT). Slugified.',
        ),
        stage: z.enum(['ideation', 'planning', 'ready', 'implementation']).optional().describe(
          'Filter tasks by stage: ideation · planning · ready · implementation.',
        ),
        label: z.string().optional().describe(
          'Filter to engrams carrying this label, e.g. review (flagged for a re-check).',
        ),
        task_id: z.string().optional().describe(
          'Everything that hangs on this task: its decisions, notes, events, logs, references, learnings.',
        ),
        binding: z.enum(['task', 'standing']).optional().describe(
          'Decisions and notes by binding: task (close with their task) · standing (without one, a decision or note is standing).',
        ),
        state: z.enum(['ripe', 'unclear', 'collecting', 'paused']).optional().describe(
          'Learnings by state: ripe (ask the user whether to make it a rule) · unclear · collecting · paused.',
        ),
        subject: z.string().optional().describe(
          'Filter to engrams belonging to this subject id (the strand they BELONG TO, cross-scope). Slugified.',
        ),
        search: z.string().optional().describe(
          'FTS5 over content/title (2-4 plain words); combine with filters.',
        ),
        order_by: z.enum(['created_at', 'updated_at', 'score']).optional().describe(
          'created_at (newest) · updated_at (last changed) · score (relevance, only with search).',
        ),
        limit: z.number().int().positive().max(200).optional().describe(
          'Page size, default ~20, max 200.',
        ),
        offset: z.number().int().nonnegative().optional().describe('Pagination offset.'),
        has_relations: z.boolean().optional().describe(
          'true = only engrams with ≥1 relation (find hub-engrams).',
        ),
      }).strict(),
    },
    async (args) => callTool(() => {
      const params: Record<string, string | number | undefined> = {}
      for (const [k, v] of Object.entries(args)) {
        if (v === undefined) continue
        params[k] = typeof v === 'boolean' ? String(v) : v as string | number
      }
      return http.get('/list', params)
    }),
  )
}
