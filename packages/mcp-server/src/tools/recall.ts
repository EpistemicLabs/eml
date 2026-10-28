import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

export function registerRecallTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_recall',
    {
      title: 'Recall Knowledge',
      description:
        'Keyword/relevance search across active + planned engrams (FTS5 full-text, not ' +
        'embeddings) — "what do I know about X?". Ranked by text relevance (bm25); ' +
        'recency breaks near-ties. Returns compact previews (with authorship: `by <handle>`, ' +
        'or `by <handle> (via <agent>)` when an agent wrote it for them) — drill into a hit via eml_get <id> for the full body.\n\n' +
        'For filtered enumeration by type/scope/status (incl. superseded/historical) use ' +
        'eml_list; for a whole-scope dashboard use eml_show; for a known ID use eml_get.',
      inputSchema: z.object({
        query: z.string().describe(
          'Plaintext, FTS5-tokenised. Domain words (2-4) beat full sentences.',
        ),
        limit: z.number().int().positive().max(50).optional().describe(
          'Default 10; raise to 20-30 only for a broad sweep.',
        ),
      }).strict(),
    },
    async (args) => callTool(() => http.post('/recall', args)),
  )
}
