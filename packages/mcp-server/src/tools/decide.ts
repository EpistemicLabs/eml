import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'

const SIGNIFICANCE = ['critical', 'high', 'normal', 'low', 'trivial'] as const
const STATUSES = ['planned', 'active', 'superseded', 'invalidated', 'expired', 'resolved'] as const

// v0.15: the schema rejects a missing rationale / alternative before the request
// reaches core, so it carries core's own wording (validate.ts) — the agent learns
// what a decision needs, not just "expected string". Blank values pass the schema
// and are rejected by core with the same text.
const NEEDS_ALTERNATIVE = 'Invalid engram: a decision needs at least one alternative that was considered and rejected.'
const NEEDS_RATIONALE = 'Invalid engram: a decision needs a rationale — why this option won.'

/**
 * v0.9 Cluster 4 step 3: typed write tool for decision engrams.
 *
 * Properties (rationale/alternatives/expires_at/review_due_at) are exposed as
 * top-level tool params, packed into a `properties` object by the tool, and
 * posted to /context.
 *
 * v0.15: decision_type dropped (written, never read); rationale and at least one
 * alternative are required — core rejects a decision without them on create.
 * task_id links the decision to the task it was taken in (derived_from + entry).
 * supersedes (spec decision 21) is packed into properties.supersedes: core flips
 * each old decision to superseded and draws the supersedes edge in the same write.
 *
 * review_due_at: server default is 60d if unset (brain hygiene).
 */
export function registerDecideTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_decide',
    {
      title: 'Record Decision',
      description:
        'Records a deliberate choice between real alternatives, with rationale ("we chose X over ' +
        'Y because Z"), that stays relevant beyond this session. alternatives (≥ 1, really ' +
        'considered) and rationale are required — if there was nothing to reject, it isn\'t a ' +
        'decision.\n\n' +
        'NOT a decision: current state → eml_set_status · an open action → eml_track_task · ' +
        'speculation → skip. If an active decision on the topic exists, supersede it instead of ' +
        'duplicating: pass its id in supersedes.\n\n' +
        'Taken while working on a task? Pass task_id — the decision is linked to the task and ' +
        'noted in its entries.\n\n' +
        'If the response carries `potential_conflicts`, evaluate each before continuing: ' +
        'supersede / merge / relate / dismiss.',
      inputSchema: {
        content: z.string().describe('The decision (1-3 sentences) — lead with the choice.'),
        scope: z.string().describe(
          'Narrowest true scope: project.<id> (usual) | entity.<id> | agent.<id> | ' +
          'user.<id> | global.',
        ),
        title: z.string().optional().describe(
          'Kebab-case recall anchor; reuse across superseding decisions for one lineage.',
        ),
        rationale: z.string({ error: NEEDS_RATIONALE }).describe(
          'Why this option won — required.',
        ),
        alternatives: z.array(z.string(), { error: NEEDS_ALTERNATIVE }).min(1, { error: NEEDS_ALTERNATIVE }).describe(
          'The options really considered and rejected, each a short phrase — at least one.',
        ),
        supersedes: z.array(z.string()).optional().describe(
          'Ids of active decisions this one replaces — each is set to superseded and linked (supersedes edge).',
        ),
        task_id: z.string().optional().describe(
          'Id of the task this decision was taken in. Links decision → task (derived_from) and adds a task entry.',
        ),
        expires_at: z.string().optional().describe(
          'ISO date — hard expiry, obsolete from then. Only for known-expiry decisions.',
        ),
        review_due_at: z.string().optional().describe(
          'ISO date — soft review reminder (boot flags overdue). Default 60d.',
        ),
        significance: z.enum(SIGNIFICANCE).optional().describe(
          'critical = irreversible/safety · high = load-bearing · normal = default · ' +
          'low/trivial = rare.',
        ),
        status: z.enum(STATUSES).optional().describe(
          'Default active. planned = not yet in effect · superseded = replaced (via ' +
          'eml_update) · invalidated = void · resolved = closed.',
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
      const properties: Record<string, unknown> = {
        rationale: args.rationale,
        alternatives: args.alternatives,
      }
      if (args.supersedes !== undefined) properties.supersedes = args.supersedes
      if (args.expires_at !== undefined) properties.expires_at = args.expires_at
      if (args.review_due_at !== undefined) properties.review_due_at = args.review_due_at
      return http.post('/context', {
        content: args.content,
        type: 'decision',
        scope: args.scope,
        title: args.title,
        status: args.status,
        significance: args.significance,
        properties,
        tags: args.tags,
        subjects: args.subjects,
        task_id: args.task_id,
      })
    }, { prefix: writeBanner }),
  )
}
