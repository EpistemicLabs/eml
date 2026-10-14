import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'

import { registerBootTool } from './boot'
import { registerRecallTool } from './recall'
import { registerListTool } from './list'
import { registerGetTool } from './get'
import { registerUpdateTool } from './update'
import { registerShowTool } from './show'
import { registerStatsTool } from './stats'
import { registerDecideTool } from './decide'
import { registerSetStatusTool } from './set-status'
import { registerTrackTaskTool } from './track-task'
import { registerTaskEntryTool } from './task-entry'
import { registerNoteTool } from './note'
import {
  registerEntitiesTool,
  registerEntityCreateTool,
  registerEntityUpdateTool,
} from './entity'
import {
  registerProjectsTool,
  registerProjectCreateTool,
  registerProjectUpdateTool,
} from './projects'
import {
  registerTagsTool,
  registerTagCreateTool,
} from './tags'
import {
  registerSubjectsTool,
  registerSubjectCreateTool,
  registerSubjectUpdateTool,
} from './subjects'
import { registerRelateTool } from './relate'

/**
 * v0.15 — 24-tool set (v0.12: 19; v0.14 adds the three subject tools + eml_relate; v0.15 adds eml_task_entry).
 *
 * Tool categories:
 *   - Boot/Recall (2): eml_boot, eml_recall
 *   - Typed write (5): eml_decide, eml_set_status, eml_track_task, eml_task_entry, eml_note
 *   - Read/Find (7): eml_show, eml_list, eml_get, eml_projects, eml_entities, eml_tags, eml_subjects
 *   - Self-awareness (1): eml_stats
 *   - Edit (1): eml_update
 *   - Project CRUD (2): eml_project_create, eml_project_update
 *   - Entity CRUD (2): eml_entity_create, eml_entity_update
 *   - Tag CRUD (1): eml_tag_create
 *   - Subject CRUD (2): eml_subject_create, eml_subject_update
 *   - Graph (1): eml_relate
 *
 * Intentionally not exposed in v0.9.1:
 *   - eml_confirm_review (brain-hygiene cluster, post-v0.9.1)
 *   - eml_session_get (→ v0.9.2 with cross-session awareness)
 *   - eml_context_store (replaced by typed tools)
 *
 * Order is not semantic — only affects the `tools/list` ordering.
 * Boot/Recall come first because they're the most-used.
 */
export function registerAllTools(server: McpServer, http: HttpClient): void {
  registerBootTool(server, http)
  registerRecallTool(server, http)
  registerDecideTool(server, http)
  registerSetStatusTool(server, http)
  registerTrackTaskTool(server, http)
  registerTaskEntryTool(server, http)
  registerNoteTool(server, http)
  registerShowTool(server, http)
  registerListTool(server, http)
  registerGetTool(server, http)
  registerProjectsTool(server, http)
  registerEntitiesTool(server, http)
  registerTagsTool(server, http)
  registerSubjectsTool(server, http)
  registerStatsTool(server, http)
  registerUpdateTool(server, http)
  registerProjectCreateTool(server, http)
  registerProjectUpdateTool(server, http)
  registerEntityCreateTool(server, http)
  registerEntityUpdateTool(server, http)
  registerTagCreateTool(server, http)
  registerSubjectCreateTool(server, http)
  registerSubjectUpdateTool(server, http)
  registerRelateTool(server, http)
}

export const TOOL_NAMES = [
  'eml_boot', 'eml_recall',
  'eml_decide', 'eml_set_status', 'eml_track_task', 'eml_task_entry', 'eml_note',
  'eml_show', 'eml_list', 'eml_get',
  'eml_projects', 'eml_entities', 'eml_stats',
  'eml_update',
  'eml_project_create', 'eml_project_update',
  'eml_entity_create', 'eml_entity_update',
  'eml_tags', 'eml_tag_create',
  'eml_subjects', 'eml_subject_create', 'eml_subject_update',
  'eml_relate',
] as const
