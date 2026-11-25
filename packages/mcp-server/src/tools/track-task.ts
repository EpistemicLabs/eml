import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { EmlApi } from '../http-client'
import { callTool, goalBanner, handOver, writeBanner, type TaskLike } from './_helpers'
import { CHECKPOINTS, PRIORITIES, STAGES, subjects, tags } from './_shared'

/**
 * v0.19: everything that happens to an existing task (POST /task/:id/track).
 * Replaces eml_task_entry and closing through eml_update. Core enforces the
 * rules (text where required, outcome on close, keep for bound items).
 */
export function registerTrackTaskTool(server: McpServer, http: EmlApi): void {
  server.registerTool('eml_track_task', {
    title: 'Track Task',
    description:
      'Everything that happens to an existing task: progress, stage, start, close, reopen, edits. Each call writes ' +
      'to the task\'s journal (shown on eml_get): your text becomes a note entry, and the server adds a short ' +
      'change entry for every field you change. Entries are append-only, so parallel sessions can write safely.\n\n' +
      'text is required for progress, a stage change, closing, reopening and a rewrite of content — write what ' +
      'happened and why; no date (entries are timestamped). For attribute edits only (priority, assignee, tags …) ' +
      'text is optional.\n\n' +
      'Closing: status=resolved (done) or invalidated (dropped) + outcome (one line, shown in task lists) + text ' +
      '(the story: what happened, what stays open). A parent can\'t be closed while sub-tasks are open: ' +
      'close each or move it to another parent first. Decisions and notes bound to the task close with it; before closing, ' +
      'check them: any that still hold once the task is done → keep (they become standing), and say why in text; ' +
      'keep=[] closes them all.\n\n' +
      'Reopening a closed task (status planned or active) needs text; the stage can change again. A closed task is ' +
      'not closed again — to change how it ended, reopen it and close it again.\n\n' +
      'Replaced by a new task? Create the new one with eml_create_task(supersedes=[id]); an existing open task ' +
      'takes over with supersedes here (task → task; bound decisions and notes move along).\n\n' +
      'Waiting on someone (a question, a review, someone outside) is not a field you set: say it in your handoff, ' +
      'and the cockpit records the wait.',
    inputSchema: z.object({
      task_id: z.string().describe('Full id of the task.'),
      text: z.string().optional().describe('Journal note, 1-3 sentences: what happened and what\'s next; required for progress, stage change, closing, reopening, content rewrite.'),
      status: z.enum(['planned', 'active', 'resolved', 'invalidated']).optional().describe('planned · active · resolved · invalidated.'),
      outcome: z.string().optional().describe('One line, required when closing.'),
      keep: z.array(z.string()).optional().describe('Required when closing a task with bound decisions or notes: the ids that outlive the task (they become standing and stay active), or [] to close them all.'),
      stage: z.enum(STAGES).nullable().optional().describe('ideation · planning · ready · implementation; frozen while the task is closed, free again after a reopen.'),
      content: z.string().optional().describe('Rewritten definition (wholesale); needs text.'),
      title: z.string().optional().describe('Rename the kebab anchor — rarely, it breaks links; the name people read is display_title.'),
      display_title: z.string().max(80).nullable().optional().describe('Set the name a person reads in a list (verb + object + scope, about 60 characters, customer or product named). Change it when the task\'s scope changes and say why in text; the journal keeps the old name. null clears.'),
      context: z.string().nullable().optional().describe('Set the context; null clears.'),
      priority: z.enum(PRIORITIES).nullable().optional().describe('urgent · high · normal · low; null clears.'),
      assignee_ids: z.array(z.string()).nullable().optional().describe('Replaces the owners: at least one person. An agent cannot clear them or name only agents.'),
      due_date: z.string().nullable().optional().describe('ISO date; null clears.'),
      parent_id: z.string().nullable().optional().describe('Move under another parent task; null makes it top-level.'),
      checkpoint: z.enum(CHECKPOINTS).nullable().optional().describe('Task system: before · after · none; null clears. Loosening (after → none, before → after/none) is Lasse\'s call: only on his explicit word.'),
      depends_on: z.array(z.string()).nullable().optional().describe('Task system: replaces the ids of the steps that must be done first; [] or null clears.'),
      delegate: z.string().nullable().optional().describe('Task system: hand the task to one agent that works on it on its own (agent handle); the owner in assignee_ids stays. Once it has a delegate and a checkpoint, the task is handed over and the runner starts it. null takes it back.'),
      goal: z.string().nullable().optional().describe('Task system: what has to be true for the task to be done, one checkable sentence; set it when you first work on a task that has none. null clears.'),
      scope: z.string().optional().describe('Move the task to another project (project.<id>); sub-tasks and bound items keep theirs.'),
      supersedes: z.array(z.string()).optional().describe('Ids of tasks this one replaces. An open one is closed as superseded, and the decisions and notes bound to it (binding task) move to this task. A closed one keeps its status and is only linked.'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async ({ task_id, ...rest }) => callTool(
    async () => {
      const args: Record<string, unknown> = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))
      if (args.delegate !== undefined || args.checkpoint !== undefined) {
        const before = await http.get(`/engram/${encodeURIComponent(task_id)}`) as TaskLike | null
        const delegation = handOver(before, args)
        if (delegation) {
          delete args.delegate
          delete args.checkpoint
          args.delegation = delegation
        }
      }
      return http.post(`/task/${encodeURIComponent(task_id)}/track`, args)
    },
    {
      // A goal or checkpoint set now is checked against the task as it stands after the call.
      prefix: (result) => {
        const props = (result as { properties?: { goal?: string; checkpoint?: string } } | null)?.properties
        const lint = rest.goal !== undefined || rest.checkpoint !== undefined ? goalBanner({ goal: props?.goal, checkpoint: props?.checkpoint }) : null
        return [lint, writeBanner(result)].filter(Boolean).join('\n\n') || null
      },
    },
  ))
}
