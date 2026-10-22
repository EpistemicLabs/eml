import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'

import { registerBootTool } from './boot'
import { registerRecallTool } from './recall'
import { registerShowTool } from './show'
import { registerListTool } from './list'
import { registerGetTool } from './get'
import { registerStatsTool } from './stats'
import {
  registerDecideTool, registerSetStatusTool, registerCreateTaskTool, registerNoteTool, registerRuleTool,
  registerEventTool, registerReferenceTool, registerLogTool, registerProfileTool,
} from './create'
import { registerLearningTool } from './learning'
import { registerTrackTaskTool } from './track-task'
import { registerUpdateTool } from './update'
import { registerRelateTool } from './relate'
import { registerReadObjectTool, registerCreateObjectTool, registerUpdateObjectTool } from './objects'

/**
 * v0.19 — 22 tools (was 24; decision mcp-tool-surface-v2). One create tool per
 * engram type, a task's life through create_task + track_task, eml_update for
 * every other engram, objects (project · entity · tag · subject) through three
 * generic tools. Hard cut, no aliases: an older client gets the upgrade hint
 * from the server.
 *
 *   - Read (6): eml_boot, eml_recall, eml_show, eml_list, eml_get, eml_stats
 *   - Create (10): eml_decide, eml_set_status, eml_create_task, eml_note, eml_rule,
 *     eml_event, eml_reference, eml_log, eml_profile, eml_learning
 *   - Change (3): eml_track_task, eml_update, eml_relate
 *   - Objects (3): eml_read_object, eml_create_object, eml_update_object
 *
 * Order only affects the tools/list ordering; the most-used come first.
 */
export function registerAllTools(server: McpServer, http: HttpClient): void {
  registerBootTool(server, http)
  registerRecallTool(server, http)
  registerShowTool(server, http)
  registerListTool(server, http)
  registerGetTool(server, http)
  registerStatsTool(server, http)
  registerDecideTool(server, http)
  registerSetStatusTool(server, http)
  registerCreateTaskTool(server, http)
  registerNoteTool(server, http)
  registerRuleTool(server, http)
  registerEventTool(server, http)
  registerReferenceTool(server, http)
  registerLogTool(server, http)
  registerProfileTool(server, http)
  registerLearningTool(server, http)
  registerTrackTaskTool(server, http)
  registerUpdateTool(server, http)
  registerRelateTool(server, http)
  registerReadObjectTool(server, http)
  registerCreateObjectTool(server, http)
  registerUpdateObjectTool(server, http)
}

export const TOOL_NAMES = [
  'eml_boot', 'eml_recall', 'eml_show', 'eml_list', 'eml_get', 'eml_stats',
  'eml_decide', 'eml_set_status', 'eml_create_task', 'eml_note', 'eml_rule',
  'eml_event', 'eml_reference', 'eml_log', 'eml_profile', 'eml_learning',
  'eml_track_task', 'eml_update', 'eml_relate',
  'eml_read_object', 'eml_create_object', 'eml_update_object',
] as const
