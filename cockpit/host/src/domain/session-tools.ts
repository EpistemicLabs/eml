import { z } from 'zod'
import type { DeliveryOutcome } from './session-delivery.js'
import type { SearchWording } from './session-directory.js'
import { WORKER_STATUSES } from './session-attention.js'
import { SORT_PICKS } from './sort.js'
import { BRIEF_TEMPLATE, SPLIT_RELATIONS } from './split.js'
import { endTurnDescription, END_TURN_INPUT, END_TURN_TOOL, LEGACY_STATUS_DESCRIPTION, LEGACY_STATUS_TOOL, statusAnswer } from './turn-end.js'

/**
 * The cockpit's own tools for a session, one definition each: the name, the
 * description an agent reads, the input shape and the answers that never
 * change. Whoever serves them (the Claude Agent SDK in this process,
 * providers/claude/sdk-runtime.ts; an MCP endpoint for a terminal session)
 * registers them from here, so a tool reads the same wherever a session finds it.
 *
 * The texts about ending a turn stay in domain/turn-end.ts and are passed on
 * as they are. What a tool does is application/session-tools.ts.
 */

export const OFFER_SPLIT_TOOL = 'offer_split'
const OFFER_SPLIT_TOOL_DESCRIPTION = 'Offer to split a new topic off this chat into a task and a session of its own. The chat shows the user a card: Split off… opens a dialog filled with what you pass, Keep it here keeps the topic in this chat. '
  + 'Call it as soon as the user brings up new work that is not part of what this session works on (its task\'s goal, or its first request), before you start on it, instead of creating a task for it yourself; a question that only clarifies the current work is not a new topic. '
  + 'Steps of the current work, and a task the user explicitly asks you to note, are not splits: create those yourself. '
  + 'Once per topic: never again for a topic the user kept here. Until they choose, answer briefly or wait; do not start real work on the new topic. '
  + 'relation: sub only if this session\'s task cannot be done without it; spun if it grew out of this work; unrelated if it has nothing to do with it. '
  + 'project: the project it belongs to (its id or name), if not this one. task: the id of an open task this topic already has (check eml_list first); the split then goes onto that task instead of making a new one. '
  + `brief: at most 12 lines from the last turns, in this shape:\n${BRIEF_TEMPLATE}`
const OFFER_SPLIT_TOOL_INPUT = {
  title: z.string().describe('The new topic in two to five words, sentence case.'),
  relation: z.enum(SPLIT_RELATIONS),
  project: z.string().optional(),
  task: z.string().optional().describe('An open task this topic already has: its id.'),
  brief: z.string(),
  reason: z.string().describe('One line: why this is a new topic.'),
}

/** What the agent reads after offering a split: nothing happened yet, the user decides. */
export const OFFER_SPLIT_ANSWER = 'Offered: the chat shows the user Split off… and Keep it here. Nothing is split until they choose; do not start on the new topic meanwhile. If they keep it here, carry on with it in this chat and do not offer it again.'

export const PROPOSE_SORT_TOOL = 'propose_sort'
const PROPOSE_SORT_TOOL_DESCRIPTION = 'Propose where each topic of this session belongs, when the session has drifted: after a compaction, or once it has covered four or more topics outside its task\'s goal. '
  + 'The chat shows the user a card; Sort topics… opens a table of your rows where they change what is wrong and apply. Nothing starts on its own; nothing happens until they apply. '
  + 'Read your own transcript and the brain (open tasks of the project) first. One row per topic, oldest first: when (a short date), topic (two to five words), summary (where it stands, a few words), '
  + 'today (what the brain has for it now: this task, a task, a linked task, nothing), pick, taskId (its task if it has one), brief (for a topic without a task: what a session needs to pick it up). '
  + 'pick: keep (it is this task\'s work) · sub (this task cannot be done without it) · spun (it grew out of this work) · unrelated (its own task, no link) · drop (close it: not needed). '
  + 'Offer it once; if the user says later, do not offer it again before the next compaction.'
const PROPOSE_SORT_TOOL_INPUT = {
  rows: z.array(z.object({
    when: z.string().optional(),
    topic: z.string(),
    summary: z.string().optional(),
    today: z.string().optional(),
    pick: z.enum(SORT_PICKS),
    taskId: z.string().optional(),
    brief: z.string().optional(),
  })),
  reason: z.string().describe('One line: why this session should be sorted now.'),
}

/** What the agent reads after proposing a sort: nothing happened yet, the user decides. */
export const PROPOSE_SORT_ANSWER = 'Proposed: the chat shows the user Sort topics… and Later. Nothing changes until they apply; carry on meanwhile.'

export const SCHEDULE_TOOL = 'schedule'
/** The schedule tool's description; `zone` names the user's own time zone, "Asia/Bangkok (UTC+7)". */
export const scheduleToolDescription = (zone?: string) => 'Schedule work for later. A schedule belongs to a task: repeating times and at most one wake-up. At the time the cockpit runs the task, even when nobody has the cockpit open. '
  + 'Use it when the user asks for something at a time or on a rhythm ("every weekday at 8:00 write the daily brief", "on Friday 10:00 check whether the customer answered"), '
  + 'not for work you can do now. '
  + 'Actions: create, list, update, pause, resume, delete, run_now, finish (the last six take job: the task\'s id or exact name; pause and resume hold the task\'s whole schedule, delete and finish end it and leave the task open). '
  + 'create needs prompt and exactly one of cron (a repeating time, five fields: minute hour day-of-month month day-of-week, e.g. "0 8 * * 1-5"; at most every 15 min) '
  + 'or at (the wake-up, e.g. "2026-11-13T10:00"; it replaces the one the task had). Times read in timezone (an IANA name), by default the user\'s own' + (zone ? ` (${zone})` : '') + '; pass it when the user names another. '
  + 'The task: task_id (one that exists), or target self (the task this session works on); without either a new task is made from name and prompt, in project (by default this one\'s). '
  + 'A run reads the task, so the prompt goes into it: a repeating time\'s as its own paragraph of the task\'s text, a wake-up\'s as its reason. Write it so it stands alone (what to do, where, and what to report). '
  + 'A repeating time starts a new session per run; a wake-up continues the session that set it if that session works on the task. '
  + 'by: who the wake-up is for. Leave it out for yourself: the cockpit runs you on the task then. Name the user\'s handle for a reminder: at the time the task lands in their Inbox as their move. '
  + 'A wake-up stays until it fires, you remove it (update, finish) or the task closes: handing the task over or ending a turn does not remove it. '
  + 'update: cron replaces the task\'s repeating times with that one, at replaces its wake-up. '
  + 'For work that answers mail, pass mail: { domains, addresses } (with or without a time): the task is then started when such mail arrives. '
  + 'It reacts only after the user\'s OK on the task in the cockpit, and its replies are drafts the user approves; you cannot change either. '
  + 'goal: what has to be true for the task to be done (e.g. "refund received"); it is set when the task has none. '
  + 'Optional: max_runs, ends_at, deny_tools (tools the task\'s sessions may not use), '
  + 'notify (needs-me: the user hears of runs that need them, the default; always; never). '
  + 'You reach the tasks of this space, and a task\'s sessions get at most this session\'s tools; a limited task\'s session reaches only its own task (update with at or goal, finish). The answer shows the next run times in words: check them against what the user asked.'
const SCHEDULE_TOOL_INPUT = {
  action: z.enum(['create', 'list', 'update', 'pause', 'resume', 'delete', 'run_now', 'finish']),
  job: z.string().optional().describe('The task whose schedule to act on: its id (or the first 8 characters) or its exact name.'),
  name: z.string().optional().describe('For a new task: a short name the user recognizes, e.g. "Daily brief".'),
  prompt: z.string().optional().describe('What a run at that time should do; it goes into the task.'),
  cron: z.string().optional(),
  at: z.string().optional(),
  timezone: z.string().optional(),
  // Any word is taken, so one the tool does not know is answered with what to do instead (application/jobs.ts).
  target: z.string().optional().describe('worker (default) or self: the task this session works on.'),
  project: z.string().optional().describe('The project a new task is made in, and where new sessions of the task start.'),
  provider: z.string().optional(),
  max_runs: z.number().int().optional(),
  ends_at: z.string().optional(),
  task_id: z.string().optional().describe('The task that gets the time.'),
  by: z.string().optional().describe('Who the wake-up (at) is for: yourself (default) or the user\'s handle for a reminder in their Inbox.'),
  goal: z.string().optional().describe('What has to be true for the task to be done; set when the task has none.'),
  deny_tools: z.array(z.string()).optional(),
  notify: z.enum(['needs-me', 'always', 'never']).optional(),
  mail: z.object({ domains: z.array(z.string()).optional(), addresses: z.array(z.string()).optional() }).optional()
    .describe('Mail that starts the task: sender domains (e.g. example.com) and addresses.'),
}

export const SEND_MESSAGE_TOOL = 'send_message'
export const LIST_SESSIONS_TOOL = 'list_sessions'

/**
 * The tool a session answers another session's message with, as its agent CLI lists it: send_message from the MCP
 * server that serves it the cockpit's tools (Codex), else Claude Code's own SendMessage.
 */
export const replyTool = (mcpServer: string | null) => (mcpServer ? `mcp__${mcpServer}__${SEND_MESSAGE_TOOL}` : 'SendMessage')

const SEND_MESSAGE_TOOL_DESCRIPTION = 'Send a message to another cockpit session of your agent: it reads the message as a prompt and acts on it, even when nobody has the cockpit open. A stopped session is resumed first. '
  + 'Use it to hand another session work, a result or a question that belongs to it, not to reach your user. '
  + `to: the session's address, exactly as ${LIST_SESSIONS_TOOL} shows it. If more than one session could be the one your user means, ask them to pick before sending: a message to the wrong session wakes it and hands it your text. `
  + 'text: all the session gets from you: write it so it stands alone (what you want, where, and where its result should go). '
  + 'A terminal session cannot receive a reply this way: the receiver\'s answer comes through the task or the user, so do not wait for one here. '
  + 'The answer says whether the session has your message; when it does not, it says what to do.'
const SEND_MESSAGE_TOOL_INPUT = {
  to: z.string().describe(`The session's address, as ${LIST_SESSIONS_TOOL} shows it.`),
  text: z.string().describe('What the session should read; it gets nothing else from you.'),
}

/** The most sessions one search shows, as GET /api/session-directory. */
export const LIST_SESSIONS_MAX = 200
const LIST_SESSIONS_TOOL_DESCRIPTION = `Find the cockpit sessions you can message with ${SEND_MESSAGE_TOOL}: the other sessions of your agent, stopped ones too, each with its address, whether it runs, when it was last active, its project and name, what it was asked and what it last reported. `
  + 'Use it to turn what your user calls a session ("the catalogue session") into an address before you send. '
  + 'words: words from what your user called it; every word has to occur in the session\'s name, what it was asked, its last status, its project or its address. Without words: the most recent sessions. '
  + 'state: running or stopped, to see only those. project: words of the project name. archived: true also searches archived sessions. '
  + `limit: how many to show, by default 10, at most ${LIST_SESSIONS_MAX}. `
  + 'The best match by name comes first, then the most recent.'
const LIST_SESSIONS_TOOL_INPUT = {
  words: z.string().optional().describe('Words from what your user called the session, separated by spaces.'),
  state: z.enum(['running', 'stopped']).optional(),
  project: z.string().optional().describe('Words of the project name.'),
  archived: z.boolean().optional(),
  limit: z.number().int().optional(),
}

/** How a search result reads for a session that searches with the tool (domain/session-directory.ts searchResult). */
export const LIST_SESSIONS_WORDING: SearchWording = {
  retry: `${LIST_SESSIONS_TOOL} with other words`,
  archived: `${LIST_SESSIONS_TOOL} with archived true`,
  recent: `${LIST_SESSIONS_TOOL} without words`,
}

/** Why the schedule tool has no answer of its own: its actions threw. */
export const scheduleFailed = (why: string) => `The schedule tool failed: ${why}`

const NO_REPLY_HERE = 'Its answer does not come back to this call: it comes through the task or the user.'

/** A send without an address or without a text: nothing was asked of the host. */
export const SEND_MESSAGE_INCOMPLETE = 'Not sent: to (the session\'s address) and text are both needed.'

/** A target the caller cannot message: not in its directory, or no session at all. One text, so an address tells nothing about other agents' sessions. */
export const notReachable = (to: string) => `Not sent: ${to} is not a session you can message. ${LIST_SESSIONS_TOOL} shows the addresses you can send to; take the address from there.`

/** The host did not answer for a reason that is not the message's. */
export const sendMessageFailed = (to: string, why: string) => `Not sent: the cockpit could not hand ${to} your message (${why.replace(/[.\s]+$/, '')}). Send it again.`

/** What the sender reads after a send: what came of it and, when the session does not have the message, what to do. */
export function sendMessageAnswer(outcome: DeliveryOutcome, to: string): string {
  switch (outcome) {
    case 'delivered': return `Delivered: ${to} runs and has your message. ${NO_REPLY_HERE}`
    case 'resumed': return `Delivered: ${to} had stopped, so the cockpit woke it and it has your message. ${NO_REPLY_HERE}`
    case 'busy': return `Not sent: ${to} cannot take it right now (it runs in a terminal, or is switching). Send it again later, or tell your user what you wanted it to know.`
    case 'unknown': return notReachable(to)
    case 'refused': return `Not sent: ${to} does not run in chat, so the cockpit cannot hand it a message. Sending again will not help: tell your user what you wanted it to know.`
    case 'running': return `Not sent: ${to} runs, and the cockpit took this message only for a stopped session. Send it again.`
  }
}

/** Whether the session has the message after this outcome. */
export const wasDelivered = (outcome: DeliveryOutcome): boolean => outcome === 'delivered' || outcome === 'resumed'

/**
 * Every tool by what it is, for whoever registers it. `description` takes the user's time zone as a session is told
 * it (domain/schedule.ts zoneLabel) where the text names it; `answer` is the fixed text of a tool that changes nothing.
 */
export const SESSION_TOOLS = {
  endTurn: { name: END_TURN_TOOL, description: endTurnDescription, input: END_TURN_INPUT },
  // A session started before the tool above still calls this one.
  legacyStatus: { name: LEGACY_STATUS_TOOL, description: () => LEGACY_STATUS_DESCRIPTION, input: { status: z.enum(WORKER_STATUSES), reason: z.string().optional() }, answer: statusAnswer },
  schedule: { name: SCHEDULE_TOOL, description: scheduleToolDescription, input: SCHEDULE_TOOL_INPUT },
  offerSplit: { name: OFFER_SPLIT_TOOL, description: () => OFFER_SPLIT_TOOL_DESCRIPTION, input: OFFER_SPLIT_TOOL_INPUT, answer: OFFER_SPLIT_ANSWER },
  proposeSort: { name: PROPOSE_SORT_TOOL, description: () => PROPOSE_SORT_TOOL_DESCRIPTION, input: PROPOSE_SORT_TOOL_INPUT, answer: PROPOSE_SORT_ANSWER },
  sendMessage: { name: SEND_MESSAGE_TOOL, description: () => SEND_MESSAGE_TOOL_DESCRIPTION, input: SEND_MESSAGE_TOOL_INPUT },
  listSessions: { name: LIST_SESSIONS_TOOL, description: () => LIST_SESSIONS_TOOL_DESCRIPTION, input: LIST_SESSIONS_TOOL_INPUT },
} as const
