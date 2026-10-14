import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool } from './_helpers'

/**
 * v0.12: tag registry tools. Tags are a controlled, cross-scope facet on
 * engrams — a registered vocabulary (parallel to projects) that only-registered
 * tags may use. eml_tags is the recall-first surface; eml_tag_create registers.
 * v0.14: wording no longer calls a tag "a subject" — subjects are their own axis
 * (tools/subjects.ts); the descriptions cross-reference each other.
 */
export function registerTagsTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_tags',
    {
      title: 'List Tags',
      description:
        'Lists the registered tag vocabulary (id + name + description). A tag is an ' +
        'abstract, recurring category — what an engram is ABOUT ("architecture", "deploy"); ' +
        'it recurs across projects and has no end. (Something that can be "done" — a concrete ' +
        'strand like "v0.14-planning" — is a subject: see eml_subjects.) CALL THIS BEFORE TAGGING: reuse an existing tag ' +
        'rather than coining a near-duplicate. Only registered tags may be used on a ' +
        'write; create a genuinely new one via eml_tag_create. (Distinct from the ' +
        'free-form project.tags field on eml_project_create.)',
      inputSchema: {},
    },
    async () => callTool(() => http.get('/tags')),
  )
}

export function registerTagCreateTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_tag_create',
    {
      title: 'Create Tag',
      description:
        'Registers a new tag in the brain vocabulary. Prerequisite for tagging: an ' +
        'engram write carrying an unregistered tag is rejected. The id is the normalized ' +
        'slug of name ("CI / CD" → "ci-cd"); re-creating an existing slug is a no-op. ' +
        'CHECK eml_tags FIRST and reuse — only coin a new tag for a genuinely new category, ' +
        'so each category is ONE hub (avoid deploy/deployment/ship splits). A tag is an ' +
        'abstract, recurring category, orthogonal to scope (the container) and type (the ' +
        'kind of engram); a strand with an end is a subject (eml_subject_create), not a tag.',
      inputSchema: {
        name: z.string().describe('The tag label, e.g. "deploy". Normalized to a kebab-case slug id.'),
        description: z.string().optional().describe('1-line meaning — keeps the vocabulary honest and reusable.'),
      },
    },
    async (args) => callTool(() => http.post('/tag', args)),
  )
}
