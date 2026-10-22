import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

// v0.19: supersedes and part_of are not drawn by hand — they come from
// supersedes on a write (also after the fact via eml_update) and parent_id.
const RELATION_VERBS = [
  'supports', 'contradicts', 'derived_from', 'refines', 'related_to', 'blocks',
] as const

/**
 * v0.14 Cluster C: the agent-facing path to the semantic graph. Draws a directed
 * edge source → target with one of the eight verbs (v0.15: + part_of; v0.16: − evaluates). Idempotent (re-relating the
 * same triple is a no-op). Complements the two automatic edge paths — auto-
 * supersede + `[[wikilinks]]` (which materialize `related_to` on write) — with
 * explicit, typed threading the write path can't infer.
 */
export function registerRelateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_relate',
    {
      title: 'Relate Engrams',
      description:
        'Draws a directed semantic edge between two engrams: source → target with a verb. ' +
        'Idempotent — re-relating the same (source, target, verb) is a no-op. Both engrams ' +
        'must already exist. Use for explicit threading the write path cannot infer; a plain ' +
        '"see also" is better written as a [[title-or-id]] wikilink in content (auto-' +
        'materializes a related_to edge). A replacement is supersedes on the new engram (on create, ' +
        'or eml_update(new_id, supersedes=[old_id]) when both exist — eml_track_task for a task); a sub-task is parent_id on ' +
        'eml_create_task / eml_track_task. Verbs: supports / contradicts / derived_from / refines / ' +
        'related_to / blocks.',
      inputSchema: z.object({
        source_id: z.string().describe('The engram the edge points FROM (full id).'),
        target_id: z.string().describe('The engram the edge points TO (full id). Must differ from source_id.'),
        relation: z.enum(RELATION_VERBS).describe(
          'Directed verb source→target: supports · contradicts · derived_from · refines · ' +
          'related_to (generic) · blocks.',
        ),
        explanation: z.string().optional().describe('1-line why — recommended for anything but related_to.'),
        strength: z.number().min(0).max(1).optional().describe('Edge weight 0–1 (default 1.0).'),
      }).strict(),
    },
    async (args) => callTool(() => http.post('/relate', { ...args, detection_method: 'agent_declared' })),
  )
}
