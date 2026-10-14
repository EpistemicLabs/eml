import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'

const TASK_PRIORITY = ['urgent', 'high', 'normal', 'low'] as const
const SIGNIFICANCE = ['critical', 'high', 'normal', 'low', 'trivial'] as const
const TASK_STATUSES = ['planned', 'active', 'superseded', 'invalidated', 'expired', 'resolved'] as const
const TASK_STAGES = ['ideation', 'planning', 'ready', 'implementation'] as const

/**
 * v0.9 Cluster 4 step 3: typed write tool for task engrams.
 *
 * Lifecycle via status: planned (default) → active → resolved/invalidated.
 * priority is execution urgency, separate from significance (importance).
 *
 * v0.15: stage (optional maturity, a property), outcome (required when the task
 * is created closed) and parent_id (part_of edge, drawn atomically by core).
 */
export function registerTrackTaskTool(server: McpServer, http: HttpClient): void {
  server.registerTool(
    'eml_track_task',
    {
      title: 'Track Task',
      description:
        'Opens a piece of work with a lifecycle. Boot surfaces open tasks (planned + active), so ' +
        'the brain is the durable inbox.\n\n' +
        'status = open / in progress / closed: planned (default; not started or parked) · active ' +
        '(started, not finished) · resolved / invalidated (closed — outcome required). Blocked ' +
        'is not a status: set blockers and keep planned.\n' +
        'stage (optional) = how mature the work is: ideation → planning → ready → implementation. Leave it ' +
        'out for small tasks.\n\n' +
        'Larger work: make the task the hub. Decisions taken along the way → ' +
        'eml_decide(task_id); the plan → eml_note(task_id); progress → eml_task_entry. Sub-tasks ' +
        '→ parent_id.\n\n' +
        'After that: progress or a stage change → eml_task_entry · closing → ' +
        'eml_update(status=resolved|invalidated, properties.outcome). Don\'t let ghost-active ' +
        'tasks pile up.\n\n' +
        'NOT a task: finished work · a way of working ("when X, do Y") → eml_note(kind=rule) · a ' +
        'state snapshot → eml_set_status · speculation → wait for commitment.\n\n' +
        'If the response carries `potential_conflicts`, evaluate each before continuing: ' +
        'supersede / merge / relate / dismiss.',
      inputSchema: {
        content: z.string().describe(
          'What needs doing (1-3 sentences), action verb first; specific enough that ' +
          '"done" is clear.',
        ),
        scope: z.string().describe(
          'Narrowest true scope: project.<id> for project work, entity.<id> for ' +
          'person/customer follow-ups. global is rare.',
        ),
        title: z.string().optional().describe(
          'Kebab-case anchor; group related tasks under one title.',
        ),
        status: z.enum(TASK_STATUSES).optional().describe(
          'planned (default) = open, not started or parked · active = started, not finished · ' +
          'resolved = done · invalidated = abandoned. resolved/invalidated need outcome.',
        ),
        stage: z.enum(TASK_STAGES).optional().describe(
          'How mature the work is: ideation (noted) · planning (options being weighed) · ready ' +
          '(decided: decisions + plan settled) · implementation (being built). Optional; frozen when the task closes.',
        ),
        outcome: z.string().optional().describe(
          'Short result when closing (resolved/invalidated): \'deployed\', \'released v0.15.0\', ' +
          '\'dropped — see <task>\'. Required on close.',
        ),
        parent_id: z.string().optional().describe(
          'Id of the parent task — makes this a sub-task (part_of). A parent can\'t be resolved ' +
          'while sub-tasks are open; invalidating it invalidates them.',
        ),
        priority: z.enum(TASK_PRIORITY).optional().describe(
          'Execution urgency (≠ significance): urgent = blocks others · high = soon · ' +
          'normal = default · low = nice-to-have.',
        ),
        due_date: z.string().optional().describe(
          'ISO date — only for a real external deadline.',
        ),
        assignee_id: z.string().optional().describe(
          'Who should act — a stable handle: an agent id (e.g. assistant) OR a user/member ' +
          'handle (e.g. alice/bob) in a shared team brain. Omit for unassigned. ' +
          'Searchable via eml_list assignee=<handle>.',
        ),
        context: z.string().optional().describe(
          'Short why/how — helps when picking it up cold later.',
        ),
        blockers: z.array(z.string()).optional().describe(
          'Each blocker one phrase; empty = unblocked.',
        ),
        significance: z.enum(SIGNIFICANCE).optional().describe(
          'Importance (≠ urgency): critical = breaks things if undone · normal = default.',
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
      const properties: Record<string, unknown> = {}
      if (args.priority !== undefined) properties.priority = args.priority
      if (args.due_date !== undefined) properties.due_date = args.due_date
      if (args.assignee_id !== undefined) properties.assignee_id = args.assignee_id
      if (args.context !== undefined) properties.context = args.context
      if (args.blockers !== undefined) properties.blockers = args.blockers
      if (args.stage !== undefined) properties.stage = args.stage
      if (args.outcome !== undefined) properties.outcome = args.outcome
      return http.post('/context', {
        content: args.content,
        type: 'task',
        scope: args.scope,
        title: args.title,
        status: args.status,
        significance: args.significance,
        properties: Object.keys(properties).length > 0 ? properties : undefined,
        tags: args.tags,
        subjects: args.subjects,
        parent_id: args.parent_id,
      })
    }, { prefix: writeBanner }),
  )
}
