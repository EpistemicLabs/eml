import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'

const SIGNIFICANCE = ['critical', 'high', 'normal', 'low', 'trivial'] as const

/**
 * v0.9 Cluster 4 step 3: typed write tool for status engrams.
 *
 * Auto-supersede: server marks old active status engrams in the same scope
 * as 'superseded' when a new active status is written (see
 * EngramStore.autoSupersedeStatusEngrams).
 *
 * `state` is required — short phrase like "v0.9 deployed", "blocked", "running".
 */
export function registerSetStatusTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_set_status',
    {
      title: 'Set Status',
      description:
        'Sets the current state of a scope. AUTO-SUPERSEDES the prior active status in the same ' +
        'scope — exactly one active status per scope, no manual cleanup.\n\n' +
        'NOT a status: open action → eml_track_task · deliberate choice with rationale → ' +
        'eml_decide · one-off event/incident (deploy, outage) → eml_note(kind=event) · a way of ' +
        'working → eml_note(kind=rule).\n\n' +
        'If the response carries `potential_conflicts`, evaluate each before continuing: ' +
        'supersede / merge / relate / dismiss.',
      inputSchema: {
        content: z.string().describe(
          'Narrative (1-3 sentences): what the state means concretely, what changed.',
        ),
        scope: z.string().describe(
          'Narrowest true scope; project.<id> is the usual for project state.',
        ),
        state: z.string().describe(
          'Short canonical phrase, NOT a sentence ("running", "v0.10.4 deployed", ' +
          '"blocked on TLS cert"). The headline eml_show displays.',
        ),
        title: z.string().optional().describe(
          'Reuse the same title across successive statuses to trace one scope\'s state-history.',
        ),
        next_step: z.string().optional().describe('What\'s planned next, one phrase.'),
        blockers: z.array(z.string()).optional().describe(
          'Each blocker one phrase; empty = unblocked.',
        ),
        significance: z.enum(SIGNIFICANCE).optional().describe(
          'critical = production-impacting · high = milestone · normal = routine.',
        ),
        tags: z.array(z.string()).optional().describe(
          'Registered tag ids (slugs from eml_tags), e.g. ["deploy","schema"].',
        ),
        subjects: z.array(z.string()).optional().describe(
          'Registered subject ids (slugs from eml_subjects) — the strand(s) this belongs to, e.g. ["v0-14-planning"].',
        ),
      },
    },
    async (args) => callTool(() => {
      const properties: Record<string, unknown> = { state: args.state }
      if (args.next_step !== undefined) properties.next_step = args.next_step
      if (args.blockers !== undefined) properties.blockers = args.blockers
      return http.post('/context', {
        content: args.content,
        type: 'status',
        scope: args.scope,
        title: args.title,
        significance: args.significance,
        properties,
        tags: args.tags,
        subjects: args.subjects,
      })
    }, { prefix: writeBanner }),
  )
}
