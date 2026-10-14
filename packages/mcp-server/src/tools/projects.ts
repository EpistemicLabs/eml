import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

const PROJECT_STATUS = ['active', 'paused', 'archived'] as const

/**
 * v0.9 Cluster 4 step 3: list all projects (optionally filtered by status).
 */
export function registerProjectsTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_projects',
    {
      title: 'List Projects',
      description:
        'Lists registered projects, optionally filtered by status. Use to check a project ' +
        'exists before creating a project-scoped engram. For one project\'s state use ' +
        'eml_show(project.<id>); for all its engrams use eml_list(scope=project.<id>).',
      inputSchema: {
        status: z.enum(PROJECT_STATUS).optional().describe(
          'active = being worked on · paused = on hold · archived = done/dropped. Default: all.',
        ),
      },
    },
    async (args) => callTool(() => http.get('/projects', args.status ? { status: args.status } : undefined)),
  )
}

export function registerProjectCreateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_project_create',
    {
      title: 'Create Project',
      description:
        'Registers a new project. Prerequisite for any engram with scope=project.<id> — ' +
        'the scope-existence check rejects writes against unknown projects. For internal ' +
        'work/codebases, NOT external parties (→ eml_entity_create). Check eml_projects ' +
        'first to avoid duplicates.',
      inputSchema: {
        id: z.string().describe(
          'Slug-style ID, kebab-case (e.g. "eml", "customer-emails"). Used as project.<id> in scopes.',
        ),
        name: z.string().describe('Human-readable display name.'),
        status: z.enum(PROJECT_STATUS).optional().describe('Default "active".'),
        goal: z.string().optional().describe(
          '1-line "what does done look like" — anchors future decisions.',
        ),
        description: z.string().optional().describe('1-2 sentences of context.'),
        owner: z.string().optional().describe('User or agent ID driving it.'),
        parent_project: z.string().optional().describe('Parent project ID for sub-projects.'),
        tags: z.array(z.string()).optional().describe('Free-form categorization tags.'),
        started_at: z.string().optional().describe('ISO date, kickoff.'),
        ended_at: z.string().optional().describe('ISO date, set when archiving.'),
      },
    },
    async (args) => callTool(() => http.post('/project', args)),
  )
}

export function registerProjectUpdateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_project_update',
    {
      title: 'Update Project',
      description:
        'Patches the project REGISTRATION (status / goal / owner / etc.) — the container, ' +
        'not its content. When status changes, also write an eml_set_status on ' +
        'scope=project.<id> to capture WHY.',
      inputSchema: {
        id: z.string().describe('Existing project slug.'),
        name: z.string().optional().describe('New display name.'),
        status: z.enum(PROJECT_STATUS).optional().describe('active | paused | archived.'),
        goal: z.string().optional().describe('Refined goal statement.'),
        description: z.string().optional().describe('Updated context.'),
        owner: z.string().optional().describe('New owner.'),
        parent_project: z.string().nullable().optional().describe(
          'null to detach, ID to re-parent.',
        ),
        tags: z.array(z.string()).optional().describe('Replaces tag list (no merge).'),
        started_at: z.string().optional().describe('ISO date.'),
        ended_at: z.string().optional().describe('ISO date, set when archiving.'),
      },
    },
    async (args) => callTool(() => {
      const { id, ...patch } = args
      return http.put(`/project/${id}`, patch)
    }),
  )
}
