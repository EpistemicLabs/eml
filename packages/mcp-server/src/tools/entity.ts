import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

const ENTITY_KINDS = ['person', 'org', 'asset'] as const

/**
 * v0.9 Cluster 4 step 3: list all entities, optionally filtered by kind.
 * Replaces the earlier `eml_entity_list` with clearer naming + symmetry to
 * `eml_projects` (container inventory).
 */
export function registerEntitiesTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_entities',
    {
      title: 'List Entities',
      description:
        'Lists registered entities (external persons / orgs / assets), ' +
        'optionally filtered by kind. Use to check an entity exists before creating an ' +
        'entity-scoped engram. For one entity\'s state use eml_show(entity.<id>); for ' +
        'fuzzy search use eml_recall.',
      inputSchema: {
        kind: z.enum(ENTITY_KINDS).optional().describe(
          'person = individual · org = company/institution · asset = system/repo/domain. Default: all.',
        ),
      },
    },
    async (args) => callTool(() => http.get('/entities', args.kind ? { kind: args.kind } : undefined)),
  )
}

export function registerEntityCreateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_entity_create',
    {
      title: 'Create Entity',
      description:
        'Registers an external entity (person / org / asset). Prerequisite ' +
        'for any engram with scope=entity.<id> — the scope-existence check rejects ' +
        'writes against unknown entities. For external parties, NOT internal projects ' +
        '(→ eml_project_create). Check eml_entities first to avoid duplicates.',
      inputSchema: {
        id: z.string().describe(
          'Slug-style ID, kebab-case (e.g. "anthropic", "stripe"). Used as entity.<id> ' +
          'in scopes — pick something stable.',
        ),
        name: z.string().describe('Human-readable display name.'),
        kind: z.enum(ENTITY_KINDS).describe(
          'person = individual · org = company/institution · asset = system/repo/domain.',
        ),
        description: z.string().optional().describe(
          '1-2 sentences: what this entity is, why it matters.',
        ),
      },
    },
    async (args) => callTool(() => http.post('/entity', args)),
  )
}

export function registerEntityUpdateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_entity_update',
    {
      title: 'Update Entity',
      description:
        'Patches the entity REGISTRATION (name / kind / description) — not knowledge ' +
        'about it. To record facts, write engrams with scope=entity.<id> (eml_decide, ' +
        'eml_note, etc.).',
      inputSchema: {
        id: z.string().describe('Existing entity slug.'),
        name: z.string().optional().describe('New display name.'),
        kind: z.enum(ENTITY_KINDS).optional().describe('Re-categorize (rare).'),
        description: z.string().optional().describe('Refined 1-2 sentence orientation.'),
      },
    },
    async (args) => callTool(() => {
      const { id, ...patch } = args
      return http.put(`/entity/${id}`, patch)
    }),
  )
}
