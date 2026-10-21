import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'
import { BINDINGS, CHANGE_TYPES, RULE_TYPES, subjects, tags } from './_shared'

/**
 * v0.19: corrects or retires any engram except a task (POST /update). The
 * patch is flat: the universal fields plus the typed fields of the engram's
 * type; core rejects a field the type does not have, with the list.
 */
export function registerUpdateTool(server: McpServer, http: HttpClient): void {
  const nullable = (what: string) => z.string().nullable().optional().describe(what)
  server.registerTool('eml_update', {
    title: 'Update Engram',
    description:
      'Corrects or retires an existing engram of any type except task (tasks → eml_track_task). Fix a detail, ' +
      'refine wording, re-scope, or take it out of play: invalidated (no longer true, no replacement). Replaced by ' +
      'something new? Don\'t patch: write the new engram with supersedes=[id]; if it already exists, pass ' +
      'supersedes=[old ids] here on the new one.\n\n' +
      'Only the fields of the engram\'s own type are accepted; the error lists them. null clears an optional ' +
      'field. If unsure of the current state, eml_get(id) first.\n\n' +
      'Reviews: changing a decision, rule or profile restarts its review and clears the review flag. If it still ' +
      'holds unchanged, confirm it with review_note — why it still holds.',
    inputSchema: z.object({
      id: z.string().describe('Engram id; a task id errors with a pointer to eml_track_task.'),
      content: z.string().optional().describe('Wholesale replacement.'),
      title: z.string().optional().describe('Rename the recall anchor (sparingly — breaks title threads).'),
      scope: z.string().optional().describe('Re-scope (e.g. saved global but really project-bound).'),
      status: z.enum(['invalidated', 'expired', 'active']).optional().describe('invalidated · expired · active (reactivation, e.g. after a mistaken invalidate). Superseded comes only from supersedes.'),
      supersedes: z.array(z.string()).optional().describe('Ids of engrams this one replaces (also across types, e.g. a reference re-filed as this note); each is set to superseded and linked.'),
      review_note: z.string().optional().describe('Decision, rule, profile only: confirms in a review that it still holds unchanged, and why.'),
      // typed fields — each only for the types that have it
      rationale: z.string().optional().describe('decision.'),
      alternatives: z.array(z.string()).optional().describe('decision.'),
      binding: z.enum(BINDINGS).optional().describe('decision, note: task · standing.'),
      expires_at: nullable('decision: ISO date.'),
      review_due_at: nullable('decision, rule, profile: ISO date.'),
      why: z.string().optional().describe('rule.'),
      agreed: z.string().optional().describe('rule: the user\'s agreement, verbatim where possible.'),
      trigger: nullable('rule: the situation, at most 80 characters.'),
      applies: z.enum(['always', 'situational']).optional().describe('rule.'),
      rule_type: z.enum(RULE_TYPES).nullable().optional().describe('rule.'),
      core: z.boolean().optional().describe('profile: true = this scope\'s core profile; if the scope already has one, it is replaced (superseded).'),
      source: z.string().optional().describe('reference.'),
      source_name: nullable('reference.'),
      checked_at: nullable('reference: ISO date the source was last verified.'),
      source_url: nullable('event.'),
      occurred_at: z.string().optional().describe('event: ISO timestamp.'),
      change_type: z.enum(CHANGE_TYPES).optional().describe('event.'),
      what: z.string().optional().describe('log.'),
      landed: z.string().optional().describe('log.'),
      next: z.string().optional().describe('log.'),
      open_threads: z.array(z.string()).optional().describe('log.'),
      detail: nullable('every type except task, learning and status.'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async ({ id, ...patch }) => callTool(
    () => http.post('/update', { id, patch: Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }),
    { prefix: writeBanner },
  ))
}
