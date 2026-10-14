import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

/**
 * v0.14: subject registry tools (spec §B). A subject is a concrete strand with a
 * lifecycle (active | closed) that groups engrams across scopes — the tag's
 * counterpart: a tag says what an engram is ABOUT, a subject what it BELONGS TO.
 * eml_subjects is the recall-first surface; eml_subject_create registers;
 * eml_subject_update closes, reopens, renames or re-describes.
 */
const SUBJECT_VS_TAG =
  'A subject is a concrete, bounded strand/undertaking with a lifecycle ("v0.14-planning", ' +
  '"norway-trip") — what an engram BELONGS TO, across scopes. Test: can it be "done"? Then ' +
  'it is a subject, not a tag (a tag is an abstract, recurring category like "architecture" ' +
  'that never ends — see eml_tags).'

export function registerSubjectsTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_subjects',
    {
      title: 'List Subjects',
      description:
        'Lists the registered subjects (id + name + description + status + engram_count), ' +
        'active first. ' + SUBJECT_VS_TAG + ' CALL THIS BEFORE ASSIGNING a subject: reuse an ' +
        'existing one rather than coining a near-duplicate. Assign via the `subjects` param on ' +
        'the write tools; only registered subjects are accepted.',
      inputSchema: {
        status: z.enum(['active', 'closed']).optional().describe('Only subjects in this state. Omit for all.'),
      },
    },
    async (args) => callTool(() => http.get('/subjects', args.status ? { status: args.status } : undefined)),
  )
}

export function registerSubjectCreateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_subject_create',
    {
      title: 'Create Subject',
      description:
        'Registers a new subject (starts active). Prerequisite for assigning it: an engram ' +
        'write carrying an unregistered subject is rejected. ' + SUBJECT_VS_TAG + ' The id is the ' +
        'normalized slug of name ("Norway Trip" → "norway-trip"); re-creating an existing slug ' +
        'is a no-op returning the existing subject with created:false (its description is NOT ' +
        'overwritten — change it via eml_subject_update). CHECK eml_subjects FIRST and reuse.',
      inputSchema: {
        name: z.string().describe('The subject name, e.g. "Norway trip". Normalized to a kebab-case slug id.'),
        description: z.string().optional().describe(
          '1-2 lines: what this strand is and when it is done. Strongly recommended — it is shown on the subject hub.',
        ),
      },
    },
    async (args) => callTool(() => http.post('/subject', args)),
  )
}

export function registerSubjectUpdateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_subject_update',
    {
      title: 'Update Subject',
      description:
        'Closes, reopens, renames or re-describes a subject. Close (status=closed) when the ' +
        'strand is over — its engrams keep their membership and the strand still renders, ' +
        'muted. Filing an engram into a closed subject later still works (the write response ' +
        'flags it). The id (slug) never changes; name is the display label only.',
      inputSchema: {
        id: z.string().describe('Subject id (slug from eml_subjects).'),
        status: z.enum(['active', 'closed']).optional().describe('closed = the strand is done · active = reopen.'),
        name: z.string().optional().describe('New display name (the id stays).'),
        description: z.string().optional().describe('New description.'),
      },
    },
    async ({ id, ...patch }) => callTool(() => http.put(`/subject/${encodeURIComponent(id)}`, patch)),
  )
}
