import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'
import { PRIORITIES, STAGES, subjects, tags } from './_shared'

/**
 * v0.19: everything that happens to an existing task (POST /task/:id/track).
 * Replaces eml_task_entry and closing through eml_update. Core enforces the
 * rules (text where required, outcome on close, keep for bound items).
 */
export function registerTrackTaskTool(server: McpServer, http: HttpClient): void {
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
      '(the story: what happened, what stays open). A parent can\'t be resolved while sub-tasks are open; ' +
      'invalidating it invalidates them. Decisions and notes bound to the task close with it; before closing, ' +
      'check them: any that still hold once the task is done → keep (they become standing), and say why in text; ' +
      'keep=[] closes them all.\n\n' +
      'Reopening a closed task (status planned or active) needs text; the stage can change again.\n\n' +
      'Replaced by a new task? Create the new one with eml_create_task(supersedes=[id]).',
    inputSchema: z.object({
      task_id: z.string().describe('Full id of the task.'),
      text: z.string().optional().describe('Journal note, 1-3 sentences: what happened and what\'s next; required for progress, stage change, closing, reopening, content rewrite.'),
      status: z.enum(['planned', 'active', 'resolved', 'invalidated']).optional().describe('planned · active · resolved · invalidated.'),
      outcome: z.string().optional().describe('One line, required when closing.'),
      keep: z.array(z.string()).optional().describe('Only when closing: ids of task-bound decisions and notes that outlive the task; they become standing and stay active. The rest close with the task.'),
      stage: z.enum(STAGES).nullable().optional().describe('ideation · planning · ready · implementation; frozen while the task is closed, free again after a reopen.'),
      content: z.string().optional().describe('Rewritten definition (wholesale); needs text.'),
      title: z.string().optional().describe('Set the title.'),
      context: z.string().nullable().optional().describe('Set the context; null clears.'),
      priority: z.enum(PRIORITIES).nullable().optional().describe('urgent · high · normal · low; null clears.'),
      assignee_id: z.string().nullable().optional().describe('Handle of who should act; null clears.'),
      due_date: z.string().nullable().optional().describe('ISO date; null clears.'),
      blockers: z.array(z.string()).nullable().optional().describe('Replaces the list; [] or null clears.'),
      parent_id: z.string().nullable().optional().describe('Move under another parent task; null makes it top-level.'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async ({ task_id, ...rest }) => callTool(
    () => http.post(`/task/${encodeURIComponent(task_id)}/track`, Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined))),
    { prefix: writeBanner },
  ))
}
