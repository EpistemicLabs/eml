import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { HttpClient } from '../http-client'
import { callTool, writeBanner } from './_helpers'
import {
  BINDINGS, CHANGE_TYPES, PRIORITIES, RULE_TYPES, STAGES, SCOPE_ANY,
  content, detail, isoDate, optIsoDate, scope, subjects, supersedes, tags, taskId, title,
} from './_shared'

/**
 * v0.19: one create tool per engram type (decision mcp-tool-surface-v2). Each
 * posts its flat arguments to POST /engram/<type>; core checks the type's
 * fields again, so the tool schema and the server agree. Texts: note
 * mcp-tool-surface-v2-tool-drafts.
 */

/** Drop undefined so the body carries only what the agent passed. */
function body(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined))
}

export function registerDecideTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_decide', {
    title: 'Record Decision',
    description:
      'Records a deliberate choice between real alternatives, with rationale ("we chose X over Y because Z"), that ' +
      'stays relevant beyond this session. If there was nothing to reject, it isn\'t a decision.\n\n' +
      'NOT a decision: current state → eml_set_status · open work → eml_create_task · how something is built → ' +
      'eml_note · a way of working → eml_rule · speculation → skip.\n\n' +
      'Taken while working on a task? Pass task_id and binding. binding = does the decision still constrain work ' +
      'once the task is done? Yes → standing (product behavior, architecture, working principles). No, it only ' +
      'governs how this task is done → task (scope, sequencing, approach, one-off measures); it closes with the ' +
      'task. Without task_id a decision is always standing.\n\n' +
      'Replaces an earlier decision? Pass its id in supersedes, don\'t duplicate. A small correction of the same ' +
      'decision → eml_update(content).',
    inputSchema: z.object({
      content: content('The decision, 1-3 sentences, lead with the choice.'),
      scope: scope(SCOPE_ANY),
      title: title('Kebab-case recall anchor; reuse across superseding decisions for one lineage.'),
      rationale: z.string().describe('Why this option won.'),
      alternatives: z.array(z.string()).min(1).describe('The options really considered and rejected, each a short phrase — at least one.'),
      task_id: taskId('The task this decision was taken in; linked and noted in its journal.'),
      binding: z.enum(BINDINGS).optional().describe('Required with task_id: task · standing (see description).'),
      supersedes: supersedes('Ids of decisions this one replaces.'),
      expires_at: optIsoDate('ISO date, hard expiry for a decision with a known end; it expires then.'),
      review_due_at: optIsoDate('ISO date, soft review reminder. Default 60 days; due ones come up in brain hygiene.'),
      detail: detail(),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/decision', body(args)), { prefix: writeBanner }))
}

export function registerSetStatusTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_set_status', {
    title: 'Set Status',
    description:
      'Sets the current state of a scope: one active status per scope, the headline eml_show displays. The scope\'s ' +
      'status_tracks says what its status is about (e.g. brain schema version); stick to that. Each call writes a ' +
      'new version and supersedes the previous one automatically, so the history stays visible.\n\n' +
      'content = what changed against the previous state, 1-3 sentences; the backstory belongs in a task journal ' +
      'or a log.\n\n' +
      'NOT a status: open work → eml_create_task · a choice with rationale → eml_decide · a one-off occurrence ' +
      '(deploy, outage) → eml_event · a way of working → eml_rule.',
    inputSchema: z.object({
      scope: scope('The scope whose state this is.'),
      state: z.string().describe('Short canonical phrase, not a sentence ("schema 17", "v0.17.17 live", "blocked on TLS cert"). The headline.'),
      content: content('What changed against the previous state, 1-3 sentences.'),
      next_step: z.string().optional().describe('What\'s planned next, one phrase.'),
      blockers: z.array(z.string()).optional().describe('One phrase each; empty = unblocked.'),
      detail: detail(),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/status', body(args)), { prefix: writeBanner }))
}

export function registerCreateTaskTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_create_task', {
    title: 'Create Task',
    description:
      'Opens a piece of work. Open tasks (planned + active) show in eml_show and the cockpit, so the brain is the ' +
      'durable inbox.\n\n' +
      'NOT a task: finished work → eml_event / eml_log · a way of working → eml_rule · a state snapshot → ' +
      'eml_set_status · speculation without commitment → wait.\n\n' +
      'After this call, everything about the task goes through eml_track_task: progress, stage, status, closing, ' +
      'edits.\n\n' +
      'Larger work: settle the intent with the user first (intent), then make the task the hub. Decisions → eml_decide(task_id, binding) · the plan → ' +
      'eml_note(task_id, binding) · sub-tasks → eml_create_task(parent_id).',
    inputSchema: z.object({
      content: content('What needs doing, 1-3 sentences, action verb first, specific enough that "done" is clear.'),
      scope: scope('Narrowest true scope: project.<id> for project work, entity.<id> for person/customer follow-ups. global is rare.'),
      title: title('Kebab-case anchor, unique enough to find the task again.'),
      intent: z.string().optional().describe('What will be different, for whom, once it\'s done, and how we\'ll notice. Settle it with the user; leave out for small tasks.'),
      context: z.string().optional().describe('Why it exists and how to pick it up cold.'),
      status: z.enum(['planned', 'active']).optional().describe('planned (default) = not started or parked · active = started. Done things are not tasks.'),
      stage: z.enum(STAGES).optional().describe('ideation · planning · ready · implementation. Leave out for small tasks.'),
      priority: z.enum(PRIORITIES).optional().describe('urgent · high · normal (default) · low. Execution urgency.'),
      assignee_id: z.string().optional().describe('Handle of who should act (agent id or user/member handle).'),
      due_date: optIsoDate('ISO date, only for a real external deadline.'),
      blockers: z.array(z.string()).optional().describe('One phrase each. Blocked is not a status: keep planned and list blockers.'),
      parent_id: z.string().optional().describe('Parent task id → sub-task (part_of).'),
      supersedes: supersedes('Ids of tasks this one replaces. An open one is closed as superseded, and the decisions and notes bound to it (binding task) move to this task. A closed one keeps its status and is only linked.'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/task', body(args)), { prefix: writeBanner }))
}

export function registerNoteTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_note', {
    title: 'Write Note',
    description:
      'Writes a thought that lives in the brain: an observation, a research note or synthesis, a working thesis, ' +
      'a plan or spec, a living tracker. The default when nothing more specific fits.\n\n' +
      'Check first: a choice with rationale → eml_decide · open work → eml_create_task · a way of working → ' +
      'eml_rule · a lesson about how you work → eml_learning · a pointer to something outside → eml_reference · ' +
      'something that happened → eml_event.\n\n' +
      'A task\'s plan or spec → pass task_id and binding (does the note still hold once the task is done? yes → ' +
      'standing, no → task; it closes with the task). A later update of a still-valid note (e.g. the next research ' +
      'round) → a new note with the same title to thread the series; the note itself is replaced → supersedes; a ' +
      'small correction → eml_update(content).\n\n' +
      'Cross-reference with [[title-or-id]] wikilinks instead of pasting ids; an id prefix of ≥ 8 chars works, ' +
      'unresolved links come back as unresolved_links.',
    inputSchema: z.object({
      content: content('The note itself.'),
      scope: scope(SCOPE_ANY),
      title: title(),
      task_id: taskId('The task this note belongs to; linked and noted in its journal.'),
      binding: z.enum(BINDINGS).optional().describe('Required with task_id: task · standing (see description).'),
      supersedes: supersedes(),
      detail: detail(),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/note', body(args)), { prefix: writeBanner }))
}

export function registerRuleTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_rule', {
    title: 'Record Rule',
    description:
      'Records a way of working the user agreed to: "when X, do Y". A rule is never written on the agent\'s own ' +
      'initiative. Two ways in:\n' +
      '1. The user states a way of working explicitly → ask whether to record it as a rule.\n' +
      '2. A learning is ripe (the eml_learning response says when) → ask whether to turn it into a rule; on yes, ' +
      'write it with from_learning=[ids].\n' +
      'Something went wrong or right once → eml_learning, not a rule. A choice about the thing being built → ' +
      'eml_decide.\n\n' +
      'Keep it short: content says only what to do (≤ 200 chars); the reason goes in why, a playbook or examples ' +
      'in detail.\n\n' +
      'applies = always → binding within its scope; global, agent and user rules are delivered at session start ' +
      '(boot), project rules with eml_show of the project. situational → binding when its trigger occurs; listed ' +
      'as title + trigger, body via eml_get.\n\n' +
      'Refining a rule → eml_update; replacing it → eml_rule(supersedes).',
    inputSchema: z.object({
      content: content('Only what to do, at most 200 characters.'),
      scope: scope('agent.<id> · user.<id> · project.<id> · global.'),
      title: title('Short name of the trigger or topic.'),
      applies: z.enum(['always', 'situational']).describe('always · situational.'),
      trigger: z.string().max(80).optional().describe('Required when situational: the situation, at most 80 characters; not repeated in content.'),
      why: z.string().describe('The rationale.'),
      agreed: z.string().describe('The user\'s agreement, verbatim where possible ("yes, make it a rule").'),
      from_learning: z.array(z.string()).optional().describe('Ids of the learnings this rule grows from; they become superseded and are linked to the rule.'),
      rule_type: z.enum(RULE_TYPES).optional().describe('constraint · process · convention · behavior · security.'),
      detail: z.string().optional().describe('Playbook, examples.'),
      review_due_at: optIsoDate('ISO date, when to re-check it. Default 90 days; due ones come up in brain hygiene.'),
      supersedes: supersedes('Ids of rules this one replaces.'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/rule', body(args)), { prefix: writeBanner }))
}

export function registerEventTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_event', {
    title: 'Record Event',
    description:
      'Records something that happened at a point in time: a release, a deploy, an incident, a migration, a ' +
      'verified milestone. occurred_at is when it really happened, not when you write it down. A wrong detail can ' +
      'be corrected with eml_update, but an event is never superseded.\n\n' +
      'NOT an event: the resulting state → eml_set_status (often both: event "v0.19.0 released" + status ' +
      '"v0.19.0 live") · a session recap → eml_log · open work → eml_create_task.\n\n' +
      'Happened while working on a task? Pass task_id; it is noted in the task\'s journal.',
    inputSchema: z.object({
      content: content('What happened, facts.'),
      scope: scope(SCOPE_ANY),
      title: title(),
      change_type: z.enum(CHANGE_TYPES).describe('created · started · completed · released · deployed · failed · incident · paused · resumed · deleted · other.'),
      occurred_at: isoDate('ISO timestamp of when it really happened.'),
      task_id: taskId('Links the event to the task and notes it in the task\'s journal.'),
      source_url: z.string().optional().describe('Link to the release, PR, incident.'),
      detail: z.string().optional().describe('Technical specifics (hosts, IPs, hashes, commit ids).'),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/event', body(args)), { prefix: writeBanner }))
}

export function registerReferenceTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_reference', {
    title: 'Record Reference',
    description:
      'Records a pointer to something outside the brain (a URL, a document, a paper, an issue, a dashboard, a file ' +
      'in a repo) and why it matters. The substance stays at the source; this engram says where it is and what it ' +
      'is good for.\n\n' +
      'NOT a reference: a synthesis, research note or working thesis that lives in the brain → eml_note · a fact ' +
      'about the thing being built → eml_note or eml_decide.',
    inputSchema: z.object({
      content: content('What it is and why it matters, short.'),
      scope: scope(SCOPE_ANY),
      title: title(),
      source: z.string().describe('URL, repo path or document id. No source, no reference.'),
      source_name: z.string().optional().describe('Publisher or site, e.g. "Anthropic docs".'),
      checked_at: optIsoDate('ISO date, when the source was last verified.'),
      task_id: taskId('The task this was found for; noted in the task\'s journal.'),
      supersedes: supersedes('Ids of references this one replaces, e.g. a newer version of the same document.'),
      detail: detail(),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/reference', body(args)), { prefix: writeBanner }))
}

export function registerLogTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_log', {
    title: 'Write Session Log',
    description:
      'Writes the session log: the one narrative of this session, so the next session can dock on. One per ' +
      'session, at the end or at a handoff to a fresh session. A second log in the same session is rejected: ' +
      'update the first with eml_update. what and next show in eml_show for the next sessions — keep each to one ' +
      'or two sentences.\n\n' +
      'Not for status reports or customer updates (→ eml_set_status / eml_note) and not for single occurrences ' +
      '(→ eml_event).',
    inputSchema: z.object({
      scope: scope('The main scope of the session.'),
      title: title('e.g. session-2026-10-15-tool-surface-v2'),
      what: z.string().describe('What the session was about.'),
      landed: z.string().describe('Where it landed: results, decisions, links.'),
      next: z.string().describe('Concrete next steps.'),
      open_threads: z.array(z.string()).optional().describe('Threads left open, one each.'),
      content: z.string().optional().describe('Longer narrative or details.'),
      task_id: taskId(),
      detail: detail(),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/log', body({ ...args, content: args.content ?? '' })), { prefix: writeBanner }))
}

export function registerProfileTool(server: McpServer, http: HttpClient): void {
  server.registerTool('eml_profile', {
    title: 'Record Profile',
    description:
      'Records a facet of who someone is: an agent, a user, or an entity (person, organization). Identity, ' +
      'preferences, background, how they work — short.\n\n' +
      'Every agent and every user has one core profile, in its own scope: the identity the boot loads every ' +
      'session (the agent\'s and each user\'s). Other profiles are facets, loaded on demand.\n\n' +
      'NOT a profile: how-to, setup or access info → eml_note / eml_reference · a way of working to follow → ' +
      'eml_rule.',
    inputSchema: z.object({
      content: content('At most 400 characters.'),
      scope: scope('agent.<id> · user.<id> · entity.<id> only — a profile is always about someone.'),
      title: title(),
      core: z.boolean().optional().describe('true = this scope\'s core profile (agent.<id> or user.<id>). If the scope already has one, it is replaced (superseded); other scopes are untouched.'),
      detail: z.string().optional().describe('Additions beyond 400 characters.'),
      review_due_at: optIsoDate('ISO date, when to re-check it. Default 180 days; due ones come up in brain hygiene.'),
      supersedes: supersedes(),
      tags: tags(),
      subjects: subjects(),
    }).strict(),
  }, async (args) => callTool(() => http.post('/engram/profile', body(args)), { prefix: writeBanner }))
}
