import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

export function registerGetTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_get',
    {
      title: 'Get Engram',
      description:
        'Fetches one engram by ID with full content + properties — the drill-down after an ID ' +
        'surfaces in eml_recall / eml_list / eml_show. Not a search: if you don\'t have the ID, ' +
        'use eml_recall. The returned `ingested_by` field is the authorship handle — who wrote ' +
        'the engram (the token\'s caller), useful in a shared team brain. `session_id` and `model` say which ' +
        'session and model wrote it. Its entries come with it, oldest ' +
        'first: a task\'s journal (note = written by an agent, change = written by the server) and the decisions ' +
        'and notes bound to it, a learning\'s evidence and ripeness, review confirmations.',
      inputSchema: z.object({
        id: z.string().describe('Engram UUID, from a recall / list / show result.'),
        with_relations: z.boolean().optional().describe(
          'Default false — pass true to include the engram\'s relations (graph edges).',
        ),
        notes_only: z.boolean().optional().describe(
          'true = leave out the server\'s change entries of a task journal (only what was written).',
        ),
      }).strict(),
    },
    async (args) => callTool(async () => {
      const params: Record<string, string | number | undefined> = {}
      if (args.with_relations !== undefined) params.with_relations = String(args.with_relations)
      const engram = await http.get(`/engram/${args.id}`, params) as { entries?: Array<{ kind: string }> }
      if (args.notes_only && Array.isArray(engram.entries)) engram.entries = engram.entries.filter(e => e.kind !== 'change')
      return engram
    }),
  )
}
