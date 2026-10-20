import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

/**
 * v0.19: the objects that organize engrams — project · entity · tag · subject —
 * through three generic tools (REST /object/<object>). Replace eml_projects /
 * _project_create / _project_update, eml_entities / _entity_*, eml_tags /
 * _tag_create, eml_subjects / _subject_*. Agents and users are managed by setup
 * and the cockpit.
 */

const OBJECTS = ['project', 'entity', 'tag', 'subject'] as const

const FIELDS =
  'Fields per object (anything else errors with the list):\n' +
  '- project (internal work: a codebase or undertaking): name, id (optional, else the slug of name; used as ' +
  'project.<id>), status active · paused · archived, goal (one line: what done looks like), description (1-2 ' +
  'sentences), owner, parent_project, started_at, status_tracks (what the project\'s status is about), metadata ' +
  '(flat text map: repo, infra, url …)\n' +
  '- entity (an external person, org or asset): name, id, kind (required) person · org · asset, status active · archived, ' +
  'description (what it is, why it matters), status_tracks, metadata\n' +
  '- tag: name (stored as its slug, "CI / CD" → "ci-cd"; an existing slug is a no-op), description (one line), ' +
  'status active · archived. Only for a genuinely new category — one tag per category, no deploy / deployment ' +
  'splits.\n' +
  '- subject: name (slugged like a tag), description (what the strand is and when it is done), status active · closed'

const fieldShape = {
  name: z.string().optional(),
  id: z.string().optional(),
  kind: z.enum(['person', 'org', 'asset']).optional(),
  status: z.enum(['active', 'paused', 'archived', 'closed']).optional(),
  goal: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  parent_project: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  status_tracks: z.string().nullable().optional(),
  metadata: z.record(z.string(), z.string()).nullable().optional(),
}

export function registerReadObjectTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_read_object', {
    title: 'Read Objects',
    description:
      'Without id: the objects of that kind with usage counts — check a project or entity exists before writing ' +
      'in its scope; reuse existing tags and subjects before creating. A tag is what engrams are ABOUT, a recurring ' +
      'category that never ends ("architecture", "deploy"); a subject is a strand they BELONG TO that can be done ' +
      '("v0.14-planning"). Archived / closed objects only with a status filter. With id: one object with all fields. A scope\'s ' +
      'dashboard stays eml_show.',
    inputSchema: z.object({
      object: z.enum(OBJECTS).describe('project · entity · tag · subject.'),
      id: z.string().optional().describe('One object by id.'),
      status: z.enum(['active', 'paused', 'archived', 'closed']).optional().describe('List only this status (archived / closed are hidden otherwise).'),
      kind: z.enum(['person', 'org', 'asset']).optional().describe('Entities only: person · org · asset.'),
    }).strict(),
  }, async (args) => callTool(() => http.get(`/object/${args.object}`, { id: args.id, status: args.status, kind: args.kind })))
}

export function registerCreateObjectTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_create_object', {
    title: 'Create Object',
    description:
      'Creates a project, entity, tag or subject. A project or entity is the scope engrams live in (project.<id>, ' +
      'entity.<id>); a tag is what engrams are ABOUT, a subject the strand they BELONG TO. Check eml_read_object ' +
      'first and reuse what exists.\n\n' + FIELDS,
    inputSchema: z.object({ object: z.enum(OBJECTS).describe('project · entity · tag · subject.'), ...fieldShape }).strict(),
  }, async ({ object, ...fields }) => callTool(
    () => http.post(`/object/${object}`, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))),
  ))
}

export function registerUpdateObjectTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_update_object', {
    title: 'Update Object',
    description:
      'Updates a project, entity, tag or subject; only the fields of that kind, null clears an optional one. ' +
      'Archiving a project sets its end date; an archived tag stays on the engrams that carry it but is not ' +
      'assigned anew. The response shows the diff. It changes the registration, not knowledge about it — facts go ' +
      'into engrams in its scope. Close a subject (status=closed) when the strand is over; its engrams keep it. An ' +
      'id never changes; name is the display label.\n\n' + FIELDS,
    inputSchema: z.object({
      object: z.enum(OBJECTS).describe('project · entity · tag · subject.'),
      ...fieldShape,
      id: z.string().describe('The object\'s id.'),
    }).strict(),
  }, async ({ object, id, ...fields }) => callTool(
    () => http.put(`/object/${object}/${encodeURIComponent(id)}`, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))),
  ))
}
