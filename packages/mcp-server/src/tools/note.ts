import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'

const NOTE_KINDS = ['note', 'rule', 'profile', 'event', 'reference', 'log'] as const
const SIGNIFICANCE = ['critical', 'high', 'normal', 'low', 'trivial'] as const
const STATUSES = ['planned', 'active', 'superseded', 'invalidated', 'expired', 'resolved'] as const

/**
 * v0.9 Cluster 4 step 3: catch-all tool for secondary context types.
 * v0.14: `note` (a thought that lives in the brain) is the default kind; the
 * five less-frequent types (rule/profile/event/reference/log) stay opt-in
 * behind `kind`. `reference` is narrowed to pointers to something outside.
 * Properties are kind-specific — passed through as a generic object and
 * validated server-side (validateProperties() checks required fields per type:
 *   - event: occurred_at + change_type required
 *   - rule:  applies required
 *   - other: no required fields
 * ).
 */
export function registerNoteTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_note',
    {
      title: 'Write Note',
      description:
        'Writes a note — a thought, observation, synthesis or working thesis that lives in the ' +
        'brain (the default, `kind` omitted) — or one of five less-frequent kinds (rule / ' +
        'profile / event / reference / log). Use ONLY after ruling out decision (eml_decide), ' +
        'status (eml_set_status) and task (eml_track_task) — see the `kind` picker. A task\'s ' +
        'plan → eml_note(task_id).\n\n' +
        'rule vs decision: a rule is a way of working ("when X, do Y"); a choice about the thing ' +
        'being worked on — even a lasting constraint — is a decision (eml_decide).\n\n' +
        'WHEN A MATCHING ACTIVE ENGRAM EXISTS:\n' +
        '- Same thing, improved → refine it via eml_update (patch content).\n' +
        '- Now wrong or replaced as the canonical version → supersede via ' +
        'eml_update(status=superseded).\n' +
        '- A distinct but still-valid related artifact (e.g. a later research update) → write a ' +
        'NEW engram, keep the old one active, and reuse its title to thread the series ' +
        '(eml_list by title retrieves the whole thread).\n' +
        'Events are immutable — never superseded.\n\n' +
        'If the response carries `potential_conflicts`, evaluate each before continuing: ' +
        'supersede / merge / relate / dismiss.',
      inputSchema: {
        kind: z.enum(NOTE_KINDS).optional().describe(
          'Default note. Pick in order, first match wins:\n' +
          '1. Session recap (max 1/session)? → log. Else never log.\n' +
          '2. Timestamped one-time occurrence (deploy, test, incident)? → event (REQUIRES ' +
          'occurred_at + change_type).\n' +
          '3. A pointer to something OUTSIDE the brain (URL, doc, paper, issue, dashboard)? → ' +
          'reference (put the link in properties.source_url).\n' +
          '4. Identity facet of an agent/user/entity? → profile (sparingly).\n' +
          '5. A way of working to follow — "when X, do Y" (the user corrected or confirmed how you ' +
          'work, or a recurring pattern)? → rule (REQUIRES applies: always|situational). A choice ' +
          'about the thing being worked on, even a lasting constraint, is a decision (eml_decide), ' +
          'not a rule.\n' +
          '6. Otherwise — a thought that lives IN the brain: observation, research note/synthesis, ' +
          'living tracker, working thesis/brief → note (omit kind). (A locked choice with ' +
          'rationale is a decision, not a note.)',
        ),
        content: z.string().describe(
          'Per kind — note: the thought itself · rule: the rule then why · profile: short fact · ' +
          'event: what happened · reference: title + why it matters · log: session recap. ' +
          'A [[title-or-id]] wikilink in the text auto-draws a related_to edge to that engram ' +
          '(v0.14) — use it to cross-reference instead of pasting ids. Matching is case-insensitive; ' +
          'an id may be given as a prefix of ≥8 chars. An unresolved link comes back as unresolved_links.',
        ),
        scope: z.string().describe(
          'Narrowest true scope: agent.<id> (self-rules/profile) · user.<id> · project.<id> · ' +
          'entity.<id> · global (cross-cutting only).',
        ),
        title: z.string().optional().describe(
          'Kebab-case recall anchor (rule: name the trigger; profile: the facet). ' +
          'Reuse the same title to thread a series (e.g. successive research updates).',
        ),
        status: z.enum(STATUSES).optional().describe(
          'Default active. Supersede rules via eml_update when refining.',
        ),
        significance: z.enum(SIGNIFICANCE).optional().describe(
          'critical = safety · high = load-bearing · normal = default · ' +
          'low/trivial = reconsider storing. Rules don\'t use significance — `applies` is their only axis.',
        ),
        properties: z.record(z.string(), z.unknown()).optional().describe(
          'event REQUIRES occurred_at (ISO) + change_type (deployed|started|completed|failed|' +
          'paused|resumed|created|deleted) · rule REQUIRES applies (always = ambient within its ' +
          'scope; situational = applies only when its context is triggered, then fully binding) · ' +
          'reference: source_url (+ optional source_name, reference_type) · ' +
          'note/profile/log: free-form.',
        ),
        task_id: z.string().optional().describe(
          'Id of the task this note belongs to (e.g. its plan). Links note → task (refines) and adds a task entry.',
        ),
        tags: z.array(z.string()).optional().describe(
          'Registered tag ids (slugs from eml_tags), e.g. ["deploy","schema"].',
        ),
        subjects: z.array(z.string()).optional().describe(
          'Registered subject ids (slugs from eml_subjects) — the strand(s) this belongs to, e.g. ["v0-14-planning"].',
        ),
      },
    },
    async (args) => callTool(() => http.post('/context', {
      content: args.content,
      type: args.kind ?? 'note',
      scope: args.scope,
      title: args.title,
      status: args.status,
      significance: args.significance,
      properties: args.properties,
      tags: args.tags,
      subjects: args.subjects,
      task_id: args.task_id,  // v0.15: edge to the task + task entry, atomic in core
    }), { prefix: writeBanner }),
  )
}
