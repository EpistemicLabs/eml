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
        'the engram (the token\'s caller), useful in a shared team brain. For a task, also ' +
        'returns its entries (oldest first).',
      inputSchema: {
        id: z.string().describe('Engram UUID, from a recall / list / show result.'),
        with_relations: z.boolean().optional().describe(
          'Default false — pass true to include the engram\'s relations (graph edges).',
        ),
      },
    },
    async (args) => callTool(() => {
      const params: Record<string, string | number | undefined> = {}
      if (args.with_relations !== undefined) params.with_relations = String(args.with_relations)
      return http.get(`/engram/${args.id}`, params)
    }),
  )
}
