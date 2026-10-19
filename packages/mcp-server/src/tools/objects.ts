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
  '- project: name, id (optional, else the slug of name), status active · paused · archived, goal, description, ' +
  'owner, parent_project, started_at, status_tracks (what the project\'s status is about), metadata (flat text map: repo, infra, url …)\n' +
  '- entity: name, id, kind person · org · asset, status active · archived, description, status_tracks, metadata\n' +
  '- tag: name, description, status active · archived\n' +
  '- subject: name, description, status active · closed'

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
      'Without id: the objects of that kind with usage counts (reuse existing tags and subjects before creating). ' +
      'Archived / closed objects only with a status filter. With id: one object with all fields. A scope\'s ' +
      'dashboard stays eml_show.',
    inputSchema: z.object({
      object: z.enum(OBJECTS).describe('project · entity · tag · subject.'),
      id: z.string().optional().describe('One object by id.'),
      status: z.enum(['active', 'paused', 'archived', 'closed']).optional().describe('List only this status (archived / closed are hidden otherwise).'),
    }).strict(),
  }, async (args) => callTool(() => http.get(`/object/${args.object}`, { id: args.id, status: args.status })))
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
      'assigned anew. The response shows the diff.\n\n' + FIELDS,
    inputSchema: z.object({
      object: z.enum(OBJECTS).describe('project · entity · tag · subject.'),
      ...fieldShape,
      id: z.string().describe('The object\'s id.'),
    }).strict(),
  }, async ({ object, id, ...fields }) => callTool(
    () => http.put(`/object/${object}/${encodeURIComponent(id)}`, Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))),
  ))
}
