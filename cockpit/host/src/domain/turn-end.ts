import { z } from 'zod'
import type { Handoff } from './handoff.js'
import { parseAt } from './schedule.js'
import type { WorkerStatus } from './session-attention.js'
import type { WaitKind } from './task-turn.js'

/**
 * How a turn ends: one end_turn call says where the task stands and whose move
 * it is, and the cockpit derives the rest (the session's status, the task's
 * wait, the check). Every text an agent reads about ending a turn is built
 * here, from shared fragments, so no rule is worded twice.
 *
 * A session without the tool (a terminal, an older session) writes the same
 * fields as a "### Handoff" block; handoffBlock and fromHandoff are the two
 * directions between the call and that block.
 */

export interface EndTurn {
  /** Where the task stands now, one sentence (shown under the task's name in every list). */
  result: string
  /** Whose move it is. Required while the task is open, unless questions or failed are given. */
  next?: { who: string; what: string; when?: string }
  /** What only the user can decide: a copy of the numbered list in the reply. */
  questions?: string[]
  /** Set when the agent could not do it: what went wrong, one sentence. */
  failed?: string
  /** For whoever picks the task up next; journal only, never the chat. */
  checked?: string
  claimed?: string
  decided?: string
}

/** Who a call is read against: the task's owner, the session's agent, the handles of the space. */
export interface TurnContext {
  owner: string
  agent: string
  members: readonly string[]
  checkpoint?: string
}

export interface TurnWait {
  who: string
  kind: WaitKind
  why: string
}

export interface DerivedTurn {
  status: WorkerStatus
  wait: TurnWait | null
  /** The time the agent looks again, as written in the call. */
  checkAt: string | null
}

/** What a reminder can name. missingOf finds call, next and when; the chat finds reply and questions. */
export type Missing = 'call' | 'reply' | 'questions' | 'next' | 'when'

export const END_TURN_TOOL = 'end_turn'
/** The tool end_turn replaced. A session from before still finds it. */
export const LEGACY_STATUS_TOOL = 'session_status'

/** The labels of the "### Handoff" block, for writing it (handoffBlock) and reading it (domain/handoff.ts). */
export const HANDOFF_LABELS = {
  heading: 'Handoff',
  result: 'Result',
  failed: 'Failed',
  checked: 'Checked',
  claimed: 'Claimed',
  decided: 'Decided',
  next: 'Next',
  questions: 'Questions',
} as const

// ── Who ──────────────────────────────────────────────────────────────────────

const SELF_ALIASES = ['me', 'self', 'agent', 'myself']
const OWNER_ALIASES = ['user', 'owner']
const OUTSIDE = 'outside:'

export type Who =
  | { kind: 'owner' | 'member' | 'self'; name: string }
  | { kind: 'outside'; name: string }

const handle = (text: string) => text.trim().replace(/^@/, '').toLowerCase()

/** Whom a `who` names. A who that is no known handle is someone outside the space. */
export function whoOf(who: string, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): Who {
  const written = who.trim()
  if (written.toLowerCase().startsWith(OUTSIDE)) return { kind: 'outside', name: written.slice(OUTSIDE.length).trim() }
  const h = handle(written)
  if (h === handle(ctx.owner) || OWNER_ALIASES.includes(h)) return { kind: 'owner', name: ctx.owner }
  if (h === handle(ctx.agent) || SELF_ALIASES.includes(h)) return { kind: 'self', name: ctx.agent }
  const member = ctx.members.find((m) => handle(m) === h)
  if (member) return { kind: 'member', name: member }
  return { kind: 'outside', name: written.replace(/^@/, '') }
}

/** A who as the journal keeps it: the handle itself, never an alias; someone outside with the prefix. */
function writtenWho(who: string, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string {
  const w = whoOf(who, ctx)
  return w.kind === 'outside' ? `${OUTSIDE}${w.name}` : w.name
}

// ── Reading a call ───────────────────────────────────────────────────────────

const WHEN_EXAMPLE = '2026-11-27T10:00'

/** The tool's input as the model sends it. Loose on purpose: readEndTurn refuses with words the agent can act on. */
export const END_TURN_INPUT = {
  result: z.string(),
  next: z.object({ who: z.string().optional(), what: z.string().optional(), when: z.string().optional() }).optional(),
  questions: z.array(z.string()).optional(),
  failed: z.string().optional(),
  checked: z.string().optional(),
  claimed: z.string().optional(),
  decided: z.string().optional(),
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const refused = (what: string) => ({ ok: false as const, error: `Not recorded: ${what} Call ${END_TURN_TOOL} again.` })

/** The tool's answer when recording a call failed for a reason that is not the call's. */
export const notRecorded = (why: string): string => refused(`${why.replace(/[.\s]+$/, '')}.`).error

/**
 * A call as the cockpit keeps it: trimmed, empty fields dropped. Refused with
 * the reason when it cannot be recorded: no result, a next without a who, a
 * when that is no time.
 */
export function readEndTurn(raw: unknown): { ok: true; call: EndTurn } | { ok: false; error: string } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const result = text(input.result)
  if (!result) return refused(`result is missing (${FIELD.result}).`)
  const call: EndTurn = { result }

  const next = (input.next && typeof input.next === 'object' ? input.next : {}) as Record<string, unknown>
  const [who, what, when] = [text(next.who), text(next.what), text(next.when)]
  if (who) {
    if (who.toLowerCase().startsWith(OUTSIDE) && !who.slice(OUTSIDE.length).trim()) return refused(`next.who is ${OUTSIDE} without a name.`)
    // Any zone will do: whether it reads as a time does not depend on it.
    if (when && parseAt(when, 'UTC') === null) return refused(`next.when "${when}" is not a time. Write it like ${WHEN_EXAMPLE}.`)
    call.next = { who: who.replace(/^@/, ''), what, ...(when ? { when } : {}) }
  } else if (what || when) {
    return refused(`next.who is missing (${FIELD.who}).`)
  }

  const questions = (Array.isArray(input.questions) ? input.questions : [input.questions]).map(text).filter(Boolean)
  if (questions.length > 0) call.questions = questions
  for (const key of ['failed', 'checked', 'claimed', 'decided'] as const) {
    const value = text(input[key])
    if (value) call[key] = value
  }
  return { ok: true, call }
}

// ── Deriving ─────────────────────────────────────────────────────────────────

/** A question as the Inbox shows it: up to its first question mark, at most 160 characters. */
export function shortQuestion(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim()
  const mark = flat.indexOf('?')
  const cut = mark >= 0 ? flat.slice(0, mark + 1) : flat
  return cut.length > 160 ? `${cut.slice(0, 159)}…` : cut
}

/** The longest a wait's why gets. */
const WHY_MAX = 300

/** What a call means for the session, the task and the check. The first match wins. */
export function deriveTurn(call: EndTurn, ctx: TurnContext): DerivedTurn {
  const wait = (who: string, kind: WaitKind, why: string): TurnWait => ({ who, kind, why: why.slice(0, WHY_MAX) })
  const checkAt = call.next?.when ?? null
  if (call.failed) return { status: 'failed', wait: wait(ctx.owner, 'stopped', call.failed), checkAt: null }
  if (call.questions?.length) {
    // A step with checkpoint before asks before it acts: its question is the go.
    const kind = ctx.checkpoint === 'before' ? 'go' : 'question'
    return { status: 'question', wait: wait(ctx.owner, kind, call.questions.map(shortQuestion).join(' · ')), checkAt }
  }
  if (call.next) {
    const who = whoOf(call.next.who, ctx)
    const what = call.next.what
    if (who.kind === 'owner') return { status: 'review', wait: wait(ctx.owner, 'review', what || `Review: ${call.result}`), checkAt }
    if (who.kind === 'member') return { status: 'done', wait: wait(who.name, 'review', what || call.result), checkAt }
    if (who.kind === 'outside') return { status: 'done', wait: wait(who.name, 'outside', what || call.result), checkAt }
    if (checkAt) return { status: 'done', wait: null, checkAt }
  }
  return { status: 'done', wait: null, checkAt: null }
}

/**
 * What the stop still lacks: no call at all; an open task whose call names no
 * next step; a next step of the agent's own without a time. `agent` is the
 * session's handle; without it only the aliases (me, self, agent) count as its own.
 */
export function missingOf(call: EndTurn | null, facts: { taskOpen: boolean; agent?: string }): Array<'call' | 'next' | 'when'> {
  if (!call) return ['call']
  if (call.failed || call.questions?.length) return []
  if (!call.next) return facts.taskOpen ? ['next'] : []
  const own = whoOf(call.next.who, { owner: '', agent: facts.agent ?? '', members: [] }).kind === 'self'
  return own && !call.next.when ? ['when'] : []
}

// ── Texts ────────────────────────────────────────────────────────────────────

/** What each field holds. The tool's description and the block's template both read from here. */
const FIELD = {
  result: 'where the task stands now, in one sentence',
  who: `the handle of the user, of another member or agent, or your own; ${OUTSIDE}<name> for someone outside the space`,
  what: 'what they do',
  when: `the time you look again, like ${WHEN_EXAMPLE} in the user's time zone`,
  questions: 'what only the user can decide',
  failed: 'what went wrong, in one sentence',
  checked: 'what you verified yourself',
  claimed: 'what you took over unverified',
  decided: 'what was decided',
}

const STOP = 'when you stop and the stop changes who has to act or where the task stands'
const PLAIN = 'for a turn that is plain conversation'
const WHEN_REQUIRED = 'required when who is you'
const nextRequired = (next: string, questions: string, failed: string) => `${next} is required while the task is open, unless ${questions} or ${failed} is set`
const VISIBLE = 'as visible text'
const NO_TOOL = `Without the ${END_TURN_TOOL} tool, end your reply with the ${HANDOFF_LABELS.heading} block instead.`

export const END_TURN_DESCRIPTION = [
  `Call ${END_TURN_TOOL} once ${STOP}. Make no call ${PLAIN}.`,
  `Write your full reply ${VISIBLE}: the user reads only that, never the call or your thinking.`,
  `result: ${FIELD.result}. It is shown under the task's name in every list.`,
  `next: whose move it is. who: ${FIELD.who}. what: ${FIELD.what}. when: ${FIELD.when}; ${WHEN_REQUIRED}. ${nextRequired('next', 'questions', 'failed')}.`,
  `questions: ${FIELD.questions}, one entry per question. Ask them in your reply as a numbered list and copy that list here.`,
  `failed: only when you could not do it: ${FIELD.failed}.`,
  `checked, claimed, decided: for whoever picks the task up next: ${FIELD.checked}, ${FIELD.claimed}, ${FIELD.decided}. They go to the task's journal, not the chat.`,
].join('\n')

/** The older tool's description: it only points to end_turn. */
export const LEGACY_STATUS_DESCRIPTION = `The older form of ${END_TURN_TOOL}, kept for sessions started before it. Use ${END_TURN_TOOL} instead.`

/** What a reminder or the tool's answer says about each missing thing. */
const MISSING: Record<Missing, string> = {
  call: `You stopped without an ${END_TURN_TOOL} call, and nobody is watching this session. Call ${END_TURN_TOOL} now.`,
  reply: `Your turn has no visible reply. Write it now, as text, not in thinking: what was asked, what you did, what changed.`,
  questions: `Your ${END_TURN_TOOL} call has questions, but your reply does not ask them. Write them in your reply as a numbered list.`,
  next: `The task is still open and no next step is recorded. Call ${END_TURN_TOOL} with next, questions or failed.`,
  when: `Your next step names you without a time. Call ${END_TURN_TOOL} with next.when: ${FIELD.when}.`,
}

const MISSING_ORDER: readonly Missing[] = ['call', 'reply', 'questions', 'next', 'when']

function missingText(missing: readonly Missing[]): string {
  // Without a call there is nothing a next step or a time could be missing from.
  const named = missing.includes('call') ? missing.filter((m) => m !== 'next' && m !== 'when') : missing
  return MISSING_ORDER.filter((m) => named.includes(m)).map((m) => MISSING[m]).join(' ')
}

/**
 * The one reminder a stop can get: it names exactly what is missing. With
 * `tool: false` (a session that cannot call) it adds the way without the tool.
 */
export function reminder(missing: readonly Missing[], opts: { tool?: boolean } = {}): string {
  const named = missingText(missing)
  return opts.tool === false && missing.some((m) => m !== 'reply' && m !== 'questions') ? `${named} ${NO_TOOL}` : named
}

function recorded(call: EndTurn, derived: DerivedTurn): string {
  const again = derived.checkAt ? `you look again at ${derived.checkAt}` : ''
  if (!derived.wait) return again ? `Recorded: ${again}.` : 'Recorded: done, nobody has to act.'
  const { who, kind } = derived.wait
  const count = call.questions?.length ?? 0
  const what = derived.status === 'failed' ? `failed, for ${who}`
    : derived.status === 'question' ? `${count > 1 ? `${count} questions` : 'question'} for ${who}`
      : derived.status === 'review' ? `review for ${who}`
        : `waiting on ${who}${kind === 'outside' ? ' (outside the space)' : ''}`
  return `Recorded: ${what}.${again ? ` Also: ${again}.` : ''}`
}

/**
 * The tool's answer: what was recorded, then what the call still lacks (the
 * agent can call again in the same turn), then the reply if it is still to come.
 */
export function endTurnAnswer(call: EndTurn, derived: DerivedTurn, opts: { missing?: readonly Missing[]; replied?: boolean } = {}): string {
  return [recorded(call, derived), missingText(opts.missing ?? []), opts.replied ? '' : `Now write your reply ${VISIBLE}.`].filter(Boolean).join(' ')
}

/** The older tool's answer: what was recorded, then the reply that is still to come. */
export const statusAnswer = (status: WorkerStatus) => `Recorded: ${status}. Now write your reply ${VISIBLE}.`

/** Added to the tool's answer when the check at next.when could not be set: the rest of the call is recorded. */
export const checkNotSet = (when: string, why: string) =>
  `The check at ${when} was not set: ${why.replace(/[.\s]+$/, '')}. Call ${END_TURN_TOOL} again with another next.when (${FIELD.when}).`

/** The block's template, for a session without the tool. */
function blockTemplate(owner: string): string[] {
  const L = HANDOFF_LABELS
  return [
    '```',
    `### ${L.heading}`,
    `${L.result}: <${FIELD.result}>`,
    `${L.failed}: <only when you could not do it: ${FIELD.failed}>`,
    `${L.checked}: <${FIELD.checked}> · ${L.claimed}: <${FIELD.claimed}>`,
    `${L.decided}: <${FIELD.decided}>`,
    `${L.next}: [<who>] <${FIELD.what}> @ <when>`,
    `${L.questions}:`,
    `- [${owner}] <${FIELD.questions}>`,
    '```',
    `who: ${FIELD.who}. when: ${FIELD.when}; ${WHEN_REQUIRED}. ${nextRequired(L.next, L.questions, L.failed)}.`,
  ]
}

/**
 * The section of a session's start context about ending a turn. `tool` says
 * whether the session has end_turn; left out, the section covers both, since
 * the start context of a terminal and of a chat is the same text.
 */
export function turnEndRules(opts: { owner: string; agent?: string | null; tool?: boolean }): string {
  const withTool = `The ${END_TURN_TOOL} tool's description is the whole rule for ending a turn.`
  const block = `end your reply with this block ${STOP}. Write no block ${PLAIN}. Leave out lines that are empty:`
  const lines = opts.tool === true ? [withTool]
    : opts.tool === false ? [`${block[0].toUpperCase()}${block.slice(1)}`, ...blockTemplate(opts.owner)]
      : [withTool, `Without that tool (a terminal), ${block}`, ...blockTemplate(opts.owner)]
  // The handles a who can name here: the tool's description says what a who is, this line who is who.
  const handles = `Handles for who: the user is ${opts.owner}${opts.agent ? `, you are ${opts.agent}` : ''}.`
  return ['## Ending a turn', ...lines, handles].join('\n')
}

/** Whether a session can call end_turn: only Claude's chat runtime registers it (providers/claude/sdk-runtime.ts). */
export const hasEndTurnTool = (session: { runtime: string; provider: string }): boolean => session.runtime === 'sdk' && session.provider === 'claude'

/** How finished work goes to its owner. The rules about closing a task say it in these words too. */
export const FOR_REVIEW = 'hand the result over for review (next names the owner)'

/**
 * How a task whose schedule is still on comes to its end: its job ends first. Which way depends on who made the job;
 * the rules about closing a task say it in these words.
 */
export const END_SCHEDULE_FIRST = `end its job first, then ${FOR_REVIEW}: a job you made with the schedule tool you end with it (action finish), a check you set by ending a turn with a time the cockpit removes once you end a turn without one`

/** What the run of a check reads in its header instead of the schedule tool's rules (domain/job.ts runHeader). */
export const CHECK_RUN_RULE = `This job is the check you set by ending a turn with a time. End this turn with a new time and it is set again; end it without one and the check is over. While it is set, never close its task: once its goal is reached, ${FOR_REVIEW} without a time; the owner closes the task.`

/** Who sets the task's waits: said once, among the task's rules. */
export const COCKPIT_ROUTES = 'Whose move it is you say only when you end a turn; the cockpit writes it into the task.'

/** Where new work goes that a session without a user at hand comes across. */
export const NEW_WORK_AT_STOP = 'Name it when you end the turn, as a question for the user.'

/**
 * The section of the start context for a task handed to an agent: what every
 * wake-up does until the goal is reached.
 */
export function untilDoneRules(): string {
  return [
    '## Until it is done',
    '- At every wake-up, check the task against its goal first. Checks are read-only; nothing goes out without the user\'s OK.',
    `- Reached: ${FOR_REVIEW}. Do not close it yourself.`,
    '- Not reached: name yourself as next, with the time you look again (when). The cockpit wakes you then: a simple check needs no schedule tool call. You decide whether and when to check again; do not ask the user about it.',
    '- Ask the user only what only they can decide. A stop without a next step (a check, a question, a review hand-over, or the task closed) is caught by the cockpit.',
  ].join('\n')
}

/** How a step's start prompt asks for each checkpoint's stop (application/task-runner.ts stepPrompt). */
export const CHECKPOINT_STOP = {
  before: `Ask the user for the go and stop. Once you have it, do the work and ${FOR_REVIEW}.`,
  after: `Do the step, then ${FOR_REVIEW}.`,
} as const

/** Sent before the cockpit stops a session nobody has used for a while. */
export const BEFORE_IDLE_STOP = `The cockpit is about to stop this session because nobody has used it for a while. Call ${END_TURN_TOOL} now, so the task shows where it stands, and reply in one line. ${NO_TOOL} The session stops after this reply.`

/** The half sentence a scheduled run's header ends "nobody may be watching: …" with (domain/job.ts runHeader). */
export const JOB_HEADER_STATUS = `end your turn with ${END_TURN_TOOL} if you have it`

/** The name of the one-time job a call's when creates. */
export const checkJobName = (taskName: string) => `Check: ${taskName}`

/** What the session reads when that job wakes it. */
export function checkPrompt(call: Pick<EndTurn, 'next' | 'questions'>, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string {
  const who = call.next ? whoOf(call.next.who, ctx) : null
  const what = call.next?.what.replace(/[.\s]+$/, '')
  const why = call.questions?.length ? ` You asked ${ctx.owner}: ${call.questions.map(shortQuestion).join(' · ')}`
    : who?.kind === 'self' ? (what ? ` You planned: ${what}.` : '')
      : who ? ` You waited on ${who.name}${what ? `: ${what}` : ''}.`
        : ''
  return `The check you set with ${END_TURN_TOOL} is due.${why} See where the task stands and act on it.`
}

// ── The block ────────────────────────────────────────────────────────────────

const oneLine = (value: string) => value.replace(/\s+/g, ' ').trim()

/** A time at the end of a Next line, after " @ ". */
const AT_END = /^(.*?)\s+@\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}\S*)$/

/** A Next line's value as written: "[who] what @ when", each part optional. */
export function readNextLine(value: string): { who: string | null; what: string; when: string | null } {
  const tagged = /^\[([^\]]+)\](?!\()\s*(.*)$/.exec(value.trim())
  const rest = (tagged ? tagged[2] : value).trim()
  const timed = AT_END.exec(` ${rest}`)
  return { who: tagged ? tagged[1].trim() : null, what: (timed ? timed[1] : rest).trim(), when: timed ? timed[2] : null }
}

/** A call as the "### Handoff" block: what goes into the task's journal. */
export function handoffBlock(call: EndTurn, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string {
  const L = HANDOFF_LABELS
  const verified = [call.checked && `${L.checked}: ${oneLine(call.checked)}`, call.claimed && `${L.claimed}: ${oneLine(call.claimed)}`].filter(Boolean).join(' · ')
  const next = call.next && [`[${writtenWho(call.next.who, ctx)}]`, oneLine(call.next.what), call.next.when && `@ ${call.next.when}`].filter(Boolean).join(' ')
  return [
    `### ${L.heading}`,
    `${L.result}: ${oneLine(call.result)}`,
    call.failed && `${L.failed}: ${oneLine(call.failed)}`,
    verified,
    call.decided && `${L.decided}: ${oneLine(call.decided)}`,
    next && `${L.next}: ${next}`,
    ...(call.questions?.length ? [`${L.questions}:`, ...call.questions.map((q) => `- [${ctx.owner}] ${oneLine(q)}`)] : []),
  ].filter(Boolean).join('\n')
}

/**
 * A block a session wrote, as the call it stands for; null when it says
 * nothing a call could hold. A Next without a [who] names nobody: no next.
 */
export function fromHandoff(handoff: Handoff, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): EndTurn | null {
  const step = handoff.nextStep?.who ? handoff.nextStep : null
  const result = handoff.result ?? handoff.failed ?? handoff.forUser[0] ?? step?.what
  if (!result) return null
  const call: EndTurn = { result }
  if (step?.who) call.next = { who: writtenWho(step.who, ctx), what: step.what, ...(step.when ? { when: step.when } : {}) }
  if (handoff.forUser.length > 0) call.questions = [...handoff.forUser]
  for (const key of ['failed', 'checked', 'claimed', 'decided'] as const) {
    const value = handoff[key]
    if (value) call[key] = value
  }
  return call
}
