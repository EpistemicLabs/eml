import { z } from 'zod'
import type { Handoff } from './handoff.js'
import { parseAt } from './schedule.js'
import type { WorkerStatus } from './session-attention.js'
import type { WaitKind } from './task-turn.js'

/**
 * How a turn ends: one end_turn call says where the task stands, whose move it is (an ask) and when the agent looks
 * again (a check), and the cockpit derives the rest: the session's status, the task's wait, the task's wake-up. Every
 * text an agent reads about ending a turn is built here, from shared fragments, so no rule is worded twice.
 *
 * Asks and check-backs are separate (decision asks-and-check-backs-are-separate): an ask is a wait on the task, the
 * check is the task's wake-up, and neither changes the other. A call that leaves check out keeps the wake-up the task
 * has; only check "none" removes it.
 *
 * A session without the tool (a terminal, an older session) writes the same fields as a "### Handoff" block;
 * handoffBlock and fromHandoff are the two directions between the call and that block. A session started before
 * 0.25 still sends next ({ who, what, when }): it is read as the ask and the check it stands for (askAndCheckOf).
 */

/** What an ask for the owner is: a step they do themselves (do), or a result to look at (review). */
export type AskKind = 'do' | 'review'
export const ASK_KINDS: readonly AskKind[] = ['do', 'review']

/** Whose move it is: who, what they do, and for the owner what kind of step it is and when it is due. */
export interface Ask {
  who: string
  what: string
  kind?: AskKind
  /** When the step is due: a date (YYYY-MM-DD) or a date and time (an instant once recorded). */
  due?: string
}

/** When the agent looks again: the task's wake-up, and what the agent reads then. */
export interface Check {
  when: string
  why: string
}

export interface EndTurn {
  /** Where the task stands now, one sentence (shown under the task's name in every list). */
  result: string
  /** Whose move it is. */
  ask?: Ask
  /** The time the agent looks again; "none" removes the task's wake-up; left out keeps it. */
  check?: Check | 'none'
  /** What only the user can decide: a copy of the numbered list in the reply. */
  questions?: string[]
  /** Set when the agent could not do it: what went wrong, one sentence. */
  failed?: string
  /** For whoever picks the task up next; journal only, never the chat. */
  checked?: string
  claimed?: string
  decided?: string
  /** The older form (sessions started before 0.25): whose move, and the time to look again. Read by askAndCheckOf. */
  next?: { who: string; what: string; when?: string }
}

/** Who a call is read against: the task's owner, the session's agent, the handles of the space. */
export interface TurnContext {
  owner: string
  agent: string
  members: readonly string[]
  checkpoint?: string
  /** The task has a next run from its schedule: a step for someone else counts without a check (deriveTurn). */
  nextRun?: boolean
}

export interface TurnWait {
  who: string
  kind: WaitKind
  why: string
  due?: string
}

export interface DerivedTurn {
  status: WorkerStatus
  wait: TurnWait | null
  /** What the call does to the task's wake-up. */
  wake: WakeEdit
}

/**
 * What a turn's end does to the wake-up of the session's task (domain/task-schedule.ts): a check sets it (the time
 * and what the agent reads then), check "none" removes it, and a call without a check keeps it, whoever set it.
 */
export type WakeEdit = { kind: 'set'; when: string; why: string } | { kind: 'remove' } | { kind: 'keep' }

/** The wake-up edit a call asks for. */
export function wakeEditOf(check: EndTurn['check'] | undefined): WakeEdit {
  if (check === 'none') return { kind: 'remove' }
  if (check) return { kind: 'set', when: check.when, why: check.why }
  return { kind: 'keep' }
}

/** What a reminder can name. missingOf finds call and next (no ask or check) and when (an ask for others without a check); the chat finds reply and questions. */
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
  ask: 'Ask',
  check: 'Check',
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

/** A who without the prefix that marks someone outside the space: the name as people read it. */
export const withoutOutside = (who: string): string => (who.trim().toLowerCase().startsWith(OUTSIDE) ? who.trim().slice(OUTSIDE.length) : who).trim()

/** A who as the journal keeps it: the handle itself, never an alias; someone outside with the prefix. */
function writtenWho(who: string, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string {
  const w = whoOf(who, ctx)
  return w.kind === 'outside' ? `${OUTSIDE}${w.name}` : w.name
}

// ── Reading a call ───────────────────────────────────────────────────────────

/** How a when is written. A pattern, not a date: an example date would lie in the past soon, and a copy of it be refused. */
const WHEN_FORMAT = 'YYYY-MM-DDTHH:MM'
/** How a due is written: a date, or a date and time. */
const DUE_FORMAT = 'YYYY-MM-DD or YYYY-MM-DDTHH:MM'
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

/** The tool's input as the model sends it. Loose on purpose: readEndTurn refuses with words the agent can act on. */
export const END_TURN_INPUT = {
  result: z.string(),
  ask: z.object({ who: z.string().optional(), what: z.string().optional(), kind: z.string().optional(), due: z.string().optional() }).optional(),
  check: z.union([z.literal('none'), z.object({ when: z.string().optional(), why: z.string().optional() })]).optional(),
  // The older form, still sent by sessions started before 0.25 (askAndCheckOf reads it); not in the description.
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

/** A due as written is a date or a time: Any zone will do to tell, whether it reads as one does not depend on it. */
const isDue = (due: string) => (DATE_ONLY.test(due) && !Number.isNaN(Date.parse(due))) || parseAt(due, 'UTC') !== null

/**
 * A call as the cockpit keeps it: trimmed, empty fields dropped. Refused with the reason when it cannot be recorded:
 * no result, an ask without a who or for yourself, a kind that is neither do nor review, a due or a check.when that
 * is no time, a check without a when. Whether the time is still to come is passedWhen's. A session started before
 * 0.25 sends next instead: it is kept as written, and read as an ask and a check (askAndCheckOf).
 */
export function readEndTurn(raw: unknown): { ok: true; call: EndTurn } | { ok: false; error: string } {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const result = text(input.result)
  if (!result) return refused(`result is missing (${FIELD.result}).`)
  const call: EndTurn = { result }

  const ask = (input.ask && typeof input.ask === 'object' ? input.ask : {}) as Record<string, unknown>
  const [who, what, kind, due] = [text(ask.who), text(ask.what), text(ask.kind).toLowerCase(), text(ask.due)]
  if (who) {
    if (who.toLowerCase().startsWith(OUTSIDE) && !who.slice(OUTSIDE.length).trim()) return refused(`ask.who is ${OUTSIDE} without a name.`)
    if (SELF_ALIASES.includes(handle(who))) return refused('ask.who is yourself: a step of your own is a check (check.when), or keep working.')
    if (kind && !(ASK_KINDS as readonly string[]).includes(kind)) return refused(`ask.kind "${kind}" is neither do nor review.`)
    if (due && !isDue(due)) return refused(`ask.due "${due}" is not a date. Write it as ${DUE_FORMAT}.`)
    call.ask = { who: who.replace(/^@/, ''), what, ...(kind ? { kind: kind as AskKind } : {}), ...(due ? { due } : {}) }
  } else if (what || kind || due) {
    return refused(`ask.who is missing (${FIELD.who}).`)
  }

  if (input.check === 'none' || text(input.check).toLowerCase() === 'none') {
    call.check = 'none'
  } else if (input.check && typeof input.check === 'object') {
    const check = input.check as Record<string, unknown>
    const [when, why] = [text(check.when), text(check.why)]
    if (!when) return refused(`check.when is missing (${FIELD.when}); to remove the wake-up, pass check "none".`)
    // Any zone will do: whether it reads as a time does not depend on it.
    if (parseAt(when, 'UTC') === null) return refused(`check.when "${when}" is not a time. Write it as ${WHEN_FORMAT}.`)
    call.check = { when, why }
  }

  // The older form, from a session started before 0.25: kept as written when the call has neither ask nor check.
  const next = (input.next && typeof input.next === 'object' ? input.next : {}) as Record<string, unknown>
  const [nextWho, nextWhat, nextWhen] = [text(next.who), text(next.what), text(next.when)]
  if (!call.ask && !call.check && nextWho) {
    if (nextWho.toLowerCase().startsWith(OUTSIDE) && !nextWho.slice(OUTSIDE.length).trim()) return refused(`next.who is ${OUTSIDE} without a name.`)
    if (nextWhen && parseAt(nextWhen, 'UTC') === null) return refused(`next.when "${nextWhen}" is not a time. Write it as ${WHEN_FORMAT}.`)
    call.next = { who: nextWho.replace(/^@/, ''), what: nextWhat, ...(nextWhen ? { when: nextWhen } : {}) }
  }

  const questions = (Array.isArray(input.questions) ? input.questions : [input.questions]).map(text).filter(Boolean)
  if (questions.length > 0) call.questions = questions
  for (const key of ['failed', 'checked', 'claimed', 'decided'] as const) {
    const value = text(input[key])
    if (value) call[key] = value
  }
  return { ok: true, call }
}

/**
 * The ask and the check a call stands for. A call of 0.25 says them itself; the older next is read as:
 *   - yourself with a when → a check;
 *   - the owner with a when → a do ask and a check (the owner's step, and the agent looks again);
 *   - the owner without one → a review ask;
 *   - anyone else → an outside ask, and a check when it has a when.
 * A check without a why gets the one checkPrompt writes.
 */
export function askAndCheckOf(call: Pick<EndTurn, 'ask' | 'check' | 'next' | 'questions'>, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): { ask?: Ask; check?: Check | 'none' } {
  const withWhy = (check: Check | 'none' | undefined, ask?: Ask): Check | 'none' | undefined =>
    check && check !== 'none' && !check.why ? { ...check, why: checkPrompt({ ask, questions: call.questions }, ctx) } : check
  if (call.ask || call.check || !call.next) {
    const out: { ask?: Ask; check?: Check | 'none' } = {}
    if (call.ask) out.ask = call.ask
    const check = withWhy(call.check, call.ask)
    if (check) out.check = check
    return out
  }
  const { who: written, what, when } = call.next
  const who = whoOf(written, ctx)
  if (who.kind === 'self') return when ? { check: { when, why: checkPrompt({ questions: call.questions, planned: what }, ctx) } } : {}
  const ask: Ask = who.kind === 'owner' ? { who: ctx.owner, what, kind: when ? 'do' : 'review' } : { who: written, what }
  return when ? { ask, check: withWhy({ when, why: '' }, ask) as Check } : { ask }
}

/**
 * Why a call whose check has passed is not recorded, or null: a check at that time would never wake anyone.
 * `at`: the moment the call is read and the zone its when is read in.
 */
export function passedWhen(call: Pick<EndTurn, 'ask' | 'check' | 'next' | 'questions'>, at: { now: number; zone: string }, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string | null {
  const { check } = askAndCheckOf(call, ctx)
  if (!check || check === 'none') return null
  const time = parseAt(check.when, at.zone)
  const field = call.check ? 'check.when' : 'next.when'
  return time !== null && time <= at.now ? `${field} "${check.when}" has passed (read in ${at.zone}); name a time that is still to come` : null
}

/** A due as the task keeps it: a date as written, a date and time read in `zone` as an instant. */
export function storedDue(due: string, zone: string): string {
  if (DATE_ONLY.test(due)) return due
  const at = parseAt(due, zone)
  return at === null ? due : new Date(at).toISOString()
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
export const WHY_MAX = 300

/**
 * What a call means for the session, the task's wait and its wake-up. The first match wins: failed, questions, the
 * ask. The wake-up follows the call's check alone (wakeEditOf), whatever the ask: an owner's move keeps the agent's
 * check-back.
 */
export function deriveTurn(call: EndTurn, ctx: TurnContext): DerivedTurn {
  const wait = (who: string, kind: WaitKind, why: string, due?: string): TurnWait => ({ who, kind, why: why.slice(0, WHY_MAX), ...(due ? { due } : {}) })
  const { ask, check } = askAndCheckOf(call, ctx)
  const wake = wakeEditOf(check)
  if (call.failed) return { status: 'failed', wait: wait(ctx.owner, 'stopped', call.failed), wake }
  if (call.questions?.length) {
    // A step with checkpoint before asks before it acts: its question is the go.
    const kind = ctx.checkpoint === 'before' ? 'go' : 'question'
    return { status: 'question', wait: wait(ctx.owner, kind, call.questions.map(shortQuestion).join(' · ')), wake }
  }
  if (ask) {
    const who = whoOf(ask.who, ctx)
    if (who.kind === 'owner') {
      // The owner's own step is finished work for the agent, as a review is: nothing it asks holds its turn open.
      if (ask.kind === 'do') return { status: 'review', wait: wait(ctx.owner, 'do', ask.what || call.result, ask.due), wake }
      return { status: 'review', wait: wait(ctx.owner, 'review', ask.what || `Review: ${call.result}`, ask.due), wake }
    }
    // A step for anyone but the owner counts only with something that brings it back up: the agent's check, or the
    // next run of the task's schedule. Without either it is no step, from a call and from a block alike.
    if (wake.kind !== 'set' && !ctx.nextRun) return { status: 'done', wait: null, wake }
    // Another member or agent is waited on like someone outside: the task stays its owner's, and nobody else's Inbox gets it.
    if (who.kind === 'member' || who.kind === 'outside') return { status: 'done', wait: wait(who.name, 'outside', ask.what || call.result, ask.due), wake }
  }
  return { status: 'done', wait: null, wake }
}

/**
 * What the stop still lacks: no call at all; an open task whose call names neither an ask, questions, a failure nor
 * a check, and has no next run from its schedule (next); an ask for anyone but the owner without a check and without
 * a next run (when): the owner sees theirs in the Inbox, nothing else brings a wait on someone else back up.
 * `nextRun`: the task has a next run from its schedule once the call is applied (a wake-up the call kept counts).
 */
export function missingOf(call: EndTurn | null, facts: { taskOpen: boolean; ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>; nextRun?: boolean }): Array<'call' | 'next' | 'when'> {
  if (!call) return ['call']
  if (call.failed || call.questions?.length) return []
  const { ask, check } = askAndCheckOf(call, facts.ctx)
  const checks = (check !== undefined && check !== 'none') || facts.nextRun === true
  if (ask && whoOf(ask.who, facts.ctx).kind === 'owner') return []
  if (ask) return checks ? [] : ['when']
  return facts.taskOpen && !checks ? ['next'] : []
}

/** Where the task stands after a turn, for the run's record: the call's result, else the block's. */
export function resultOfTurn(call: Pick<EndTurn, 'result'> | null | undefined, handoff: Pick<Handoff, 'result'> | null | undefined): string | null {
  return call?.result ?? handoff?.result ?? null
}

// ── Texts ────────────────────────────────────────────────────────────────────

/** What each field holds. The tool's description and the block's template both read from here. */
const FIELD = {
  result: 'where the task stands now, in one sentence',
  who: `the handle of the user, or of another member or agent; ${OUTSIDE}<name> for someone outside the space`,
  what: 'what they do',
  kind: 'for the user: do (a step they take themselves, outside this chat: sign, call, send, decide; their Inbox shows it as their move) or review (a result to look at; the default)',
  due: `when the step is due, as ${DUE_FORMAT}`,
  when: `the time you look again, as ${WHEN_FORMAT} in the user's time zone`,
  why: 'what you will check then; you read it when the cockpit wakes you',
  questions: 'what only the user can decide',
  failed: 'what went wrong, in one sentence',
  checked: 'what you verified yourself',
  claimed: 'what you took over unverified',
  decided: 'what was decided',
}

/** The when field, naming the user's zone when it is known: "… in the user's time zone: Asia/Bangkok (UTC+7)". */
const whenField = (zone?: string | null) => (zone ? `${FIELD.when}: ${zone}` : FIELD.when)

const STOP = 'when you stop and the stop changes who has to act or where the task stands'
const PLAIN = 'for a turn that is plain conversation'
/** An ask for someone else needs something that brings the task back up. */
const OTHERS_NEED_CHECK = 'An ask for anyone but the user needs a check, or a next run from the task\'s schedule'
/** What a check does to the task's wake-up, and what leaving it out does. */
const CHECK_KEEPS = 'It replaces the task\'s wake-up. Leave check out to keep the wake-up the task has; "none" removes it. An ask never removes it: the user\'s move and your check-back stand side by side'
/** What an open task needs from a call. */
const OPEN_NEEDS = 'While the task is open, a call needs an ask, questions, failed or a check, unless the task has a next run from its schedule'
/** Said once, with the next step: an agent that waits for nothing has no reason to stop. */
const KEEP_WORKING = 'If the next step is yours and you wait for nothing, do not end the turn: keep working.'
const VISIBLE = 'as visible text'
const NO_TOOL = `Without the ${END_TURN_TOOL} tool, end your reply with the ${HANDOFF_LABELS.heading} block instead.`

/**
 * How a session has end_turn: built in (true, a chat session), not at all (false), or from an MCP server of this
 * name (a terminal session, cockpit-mcp.ts). Such a session is told the tool's name and its whole rule: an agent CLI
 * may list an MCP server's tools without loading their descriptions, and then never reads the rule (tried with Codex:
 * told only that the description is the rule, it did not call).
 */
export type EndTurnAccess = boolean | { mcpServer: string }

/** The tool as an agent CLI lists it when it comes from an MCP server. */
const mcpTool = (server: string) => `mcp__${server}__${END_TURN_TOOL}`

/**
 * The tool's description. `zone`: the user's time zone as a session is told it (domain/schedule.ts zoneLabel,
 * "Asia/Bangkok (UTC+7)"); without it the description says only "the user's time zone".
 */
export function endTurnDescription(zone?: string | null): string {
  return [
    `Call ${END_TURN_TOOL} once ${STOP}. Make no call ${PLAIN}.`,
    `Call it first, then write your reply once ${VISIBLE}, as the last thing in the turn: the user reads only that, never the call or your thinking.`,
    `result: ${FIELD.result}. It is shown under the task's name in every list.`,
    `ask: whose move it is, when it is not yours. who: ${FIELD.who}. what: ${FIELD.what}. kind: ${FIELD.kind}. due: ${FIELD.due}. ${OTHERS_NEED_CHECK}.`,
    `check: when you look again. when: ${whenField(zone)}. why: ${FIELD.why}. ${CHECK_KEEPS}.`,
    `${OPEN_NEEDS}. ${KEEP_WORKING}`,
    `questions: ${FIELD.questions}, one entry per question. Ask them in your reply as a numbered list and copy that list here.`,
    `failed: only when you could not do it: ${FIELD.failed}.`,
    `checked, claimed, decided: for whoever picks the task up next: ${FIELD.checked}, ${FIELD.claimed}, ${FIELD.decided}. They go to the task's journal, not the chat.`,
    'The answer says what the task holds after the call: its asks, its check, its repeating times and its next run. Check it against what you meant.',
  ].join('\n')
}

export const END_TURN_DESCRIPTION = endTurnDescription()

/** The older tool's description: it only points to end_turn. */
export const LEGACY_STATUS_DESCRIPTION = `The older form of ${END_TURN_TOOL}, kept for sessions started before it. Use ${END_TURN_TOOL} instead.`

const CALL_WITH_NEXT = `Call ${END_TURN_TOOL} with an ask, a check, questions or failed.`

/** What a reminder or the tool's answer says about each missing thing. */
const MISSING: Record<Missing, string> = {
  call: `You stopped without an ${END_TURN_TOOL} call, and nobody is watching this session. Call ${END_TURN_TOOL} now.`,
  reply: `No visible reply follows your call. Write it now, as text, not in thinking: what was asked, what you did, what changed.`,
  questions: `Your ${END_TURN_TOOL} call has questions, but your reply does not ask them. Write them in your reply as a numbered list.`,
  next: `The task is still open, and nothing says who moves next: no ask, no check, and no next run from its schedule. ${CALL_WITH_NEXT}`,
  when: `An ask for anyone but the user needs something that brings the task back up, and this task has no check and no next run from its schedule. Call ${END_TURN_TOOL} with check.when: ${FIELD.when}.`,
}

const MISSING_ORDER: readonly Missing[] = ['call', 'reply', 'questions', 'next', 'when']

function missingText(missing: readonly Missing[]): string {
  // Without a call there is nothing an ask or a check could be missing from.
  const named = missing.includes('call') ? missing.filter((m) => m !== 'next' && m !== 'when') : missing
  return MISSING_ORDER.filter((m) => named.includes(m)).map((m) => MISSING[m]).join(' ')
}

/**
 * The one reminder a stop can get: it names exactly what is missing. With a
 * tool from an MCP server it adds the name the tool goes by there. Only a chat
 * session gets one (a terminal fallback session has no turn routing).
 */
export function reminder(missing: readonly Missing[], opts: { tool?: EndTurnAccess } = {}): string {
  const named = missingText(missing)
  if (typeof opts.tool !== 'object' || !missing.some((m) => m !== 'reply' && m !== 'questions')) return named
  return `${named} The tool is ${mcpTool(opts.tool.mcpServer)}, from the MCP server ${opts.tool.mcpServer}.`
}

/** The time a check was saved for: the zone its when was read in and the instant. */
export interface CheckTime {
  at: number
  zone: string
}

/** "(Asia/Bangkok, 2026-11-26T13:15Z)": the zone a when was read in and the instant saved (the chat reads it, frontend turn-end-line.ts). */
export const savedAs = (time: CheckTime) => `(${time.zone}, ${new Date(time.at).toISOString().slice(0, 16)}Z)`

/** What the answer opens with: what the call recorded. A check that was not set is not named as one. */
function recorded(call: EndTurn, derived: DerivedTurn, lacks: { step: boolean; check: boolean }, time?: CheckTime | null, nextRun = false): string {
  const set = derived.wake.kind === 'set' && !lacks.check ? derived.wake : null
  // An ask for someone else without a check of its own: the task's schedule brings it back up.
  const byRun = nextRun && derived.wait?.kind === 'outside' && !set
  const again = set ? `you look again at ${set.when}${time ? ` ${savedAs(time)}` : ''}`
    : derived.wake.kind === 'remove' && !lacks.check ? 'the task\'s wake-up is removed'
      : byRun ? 'the task\'s next run brings it back up' : ''
  if (!derived.wait) {
    if (again) return `Recorded: ${again}.`
    return lacks.step || lacks.check ? 'Recorded: where the task stands, but nobody has a move.' : 'Recorded: done, nobody has to act.'
  }
  const { who } = derived.wait
  const count = call.questions?.length ?? 0
  const what = derived.status === 'failed' ? `failed, for ${who}`
    : derived.status === 'question' ? `${count > 1 ? `${count} questions` : 'question'} for ${who}`
      : derived.wait.kind === 'do' ? `${who}'s move`
        : derived.status === 'review' ? `review for ${who}`
          : `waiting on ${who}`
  return `Recorded: ${what}.${again ? ` Also: ${again}.` : ''}`
}

/** What helps when a check could not be set: another time, the same call again, or nothing the agent can do. */
export type CheckFix = 'time' | 'again' | 'none'

/** The check could not be set: the rest of the call is recorded. `why` is the schedule's own word on it. */
const checkNotSet = (when: string, why: string, fix: CheckFix) =>
  `The check at ${when} was NOT set: ${why.replace(/^at:\s*/i, '').replace(/[.\s]+$/, '')}.${
    fix === 'time' ? ` Call ${END_TURN_TOOL} again with another check.when (${FIELD.when}).` : fix === 'again' ? ` Call ${END_TURN_TOOL} again.` : ''}`

/** The wake-up could not be removed (check "none"): the rest of the call is recorded. */
const removeFailed = (why: string) => `The wake-up was NOT removed: ${why.replace(/[.\s]+$/, '')}. Call ${END_TURN_TOOL} again.`

const NOW_REPLY = `Now write your reply ${VISIBLE}.`

/**
 * The tool's answer: what was recorded, then what the call still lacks (the agent can call again in the same turn),
 * then what the task holds after the call (`state`, domain/turn-state-echo.ts: always there when the cockpit could
 * read the task), then the reply, which comes after the call. `checkProblem`: why the wake-up could not be set or
 * removed, and `checkFix` what helps; `checkTime`: the zone check.when was read in and the instant the task's wake-up
 * was saved for; `nextRun`: the task has a next run from its schedule.
 */
export function endTurnAnswer(call: EndTurn, derived: DerivedTurn, opts: { missing?: readonly Missing[]; checkProblem?: string | null; checkFix?: CheckFix; checkTime?: CheckTime | null; nextRun?: boolean; state?: string | null } = {}): string {
  const missing = opts.missing ?? []
  const problem = !opts.checkProblem ? ''
    : derived.wake.kind === 'set' ? checkNotSet(derived.wake.when, opts.checkProblem, opts.checkFix ?? 'time')
      : derived.wake.kind === 'remove' ? removeFailed(opts.checkProblem) : ''
  // The opening says nobody has a move: the task being open is all that is left to add.
  const lacking = !derived.wait && missing.includes('next') ? `The task is still open. ${CALL_WITH_NEXT}` : missingText(missing)
  return [recorded(call, derived, { step: missing.length > 0, check: problem !== '' }, opts.checkTime, opts.nextRun), problem, lacking, opts.state ?? '', NOW_REPLY].filter(Boolean).join(' ')
}

/** The older tool's answer: what was recorded, then the reply that is still to come. */
export const statusAnswer = (status: WorkerStatus) => `Recorded: ${status}. ${NOW_REPLY}`

/** The line of a start context that names the user's time zone (domain/schedule.ts zoneLabel). */
export const userZoneLine = (zone: string) => `Times: the user's time zone is ${zone}. Read every time the user names, and write every time you give them or the cockpit, in it, unless the time names another zone.`

/**
 * The section of a session's start context about ending a turn, for a session that has end_turn: built in, it reads
 * the tool's description; from an MCP server, the tool's name and its rule in full (see EndTurnAccess). A session
 * without it (a Claude Code session in the terminal fallback) has no turn routing and gets no section
 * (application/session-task.ts). `zone`: the user's time zone as the session is told it ("Asia/Bangkok (UTC+7)").
 */
export function turnEndRules(opts: { owner: string; agent?: string | null; tool: true | { mcpServer: string }; zone?: string | null }): string {
  const rule = `The ${END_TURN_TOOL} tool's description is the whole rule for ending a turn.`
  const lines = opts.tool === true ? [rule]
      : [
        `End a turn with the ${END_TURN_TOOL} tool: ${mcpTool(opts.tool.mcpServer)}, from the MCP server ${opts.tool.mcpServer}. This is its whole rule:`,
        endTurnDescription(opts.zone),
        'A note on the task does not replace the call: only the call says whose move it is.',
      ]
  // The handles a who can name here: the tool's description says what a who is, this line who is who.
  const handles = `Handles for who: the user is ${opts.owner}${opts.agent ? `, you are ${opts.agent}` : ''}.`
  return ['## Ending a turn', ...lines, handles, ...(opts.zone ? [userZoneLine(opts.zone)] : [])].join('\n')
}

/** How finished work goes to its owner. The rules about closing a task say it in these words too. */
export const FOR_REVIEW = 'hand the result over for review (an ask for the owner, kind review)'

/**
 * How a task whose schedule is still on comes to its end. Repeating times are ended first: a review of a task that
 * still has them approves one run and leaves it open. A wake-up ends with the task: the owner's Looks good closes it
 * and ends the wake-up. The rules about closing a task say it in these words.
 */
export const END_SCHEDULE_FIRST = `end its repeating times first with the schedule tool (action finish), then ${FOR_REVIEW}; a wake-up needs no step of yours: it ends when the task closes`

/** Who sets the task's waits: said once, among the task's rules. */
export const COCKPIT_ROUTES = 'Whose move it is you say only when you end a turn; the cockpit writes it into the task.'

/** Where new work goes that a session without a user at hand comes across. */
export const NEW_WORK_AT_STOP = 'Name it when you end the turn, as a question for the user.'

/**
 * The section of the start context for a task handed to an agent: what every
 * wake-up does until the goal is reached.
 */
export function untilDoneRules(checkpoint?: string): string {
  return [
    '## Until it is done',
    '- At every wake-up, check the task against its goal first. Checks are read-only; nothing goes out without the user\'s OK.',
    // Checkpoint none: nobody reviews it, so the agent closes it, as the closing rule says, which also keeps a task
    // whose schedule is still on open.
    checkpoint === 'none'
      ? '- Reached: close it yourself (eml_track_task with status resolved and the outcome), unless its schedule is still on (see Closing).'
      : `- Reached: ${FOR_REVIEW}. Do not close it yourself.`,
    '- Not reached: set a check with the time you look again (check.when); a task that keeps a wake-up, or has a next run from its schedule, needs none. The cockpit wakes you then: a simple check needs no schedule tool call. You decide whether and when to check again; do not ask the user about it.',
    '- When the user has to do something before you can go on (sign, call, send), ask them for it (kind do) and keep your check: it shows as their move, and their Done wakes you.',
    '- Ask the user only what only they can decide. A stop without an ask, a check, a question or the task closed is caught by the cockpit.',
  ].join('\n')
}

/** How a step's start prompt asks for each checkpoint's stop (application/task-runner.ts stepPrompt). */
export const CHECKPOINT_STOP = {
  before: `Ask the user for the go and stop. Once you have it, do the work and ${FOR_REVIEW}.`,
  after: `Do the step, then ${FOR_REVIEW}.`,
} as const

/** Sent before the cockpit stops a session nobody has used for a while. */
export const BEFORE_IDLE_STOP = `The cockpit is about to stop this session because nobody has used it for a while. Call ${END_TURN_TOOL} now, so the task shows where it stands, and reply in one line. ${NO_TOOL} The session stops after this reply.`

/** The half sentence the line of a run for a task's schedule ends "Nobody may be watching: …" with (domain/run-text.ts firedText). */
export const JOB_HEADER_STATUS = `end your turn with ${END_TURN_TOOL} if you have it`

/**
 * The reason of a wake-up a call sets without a why of its own (schedule.why): what the session reads when it fires.
 * `planned`: what the agent planned for itself (an older call's next for itself).
 */
export function checkPrompt(call: { ask?: Ask; questions?: string[]; planned?: string }, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string {
  const who = call.ask ? whoOf(call.ask.who, ctx) : null
  const what = call.ask?.what.replace(/[.\s]+$/, '')
  const planned = call.planned?.replace(/[.\s]+$/, '')
  const why = call.questions?.length ? ` You asked ${ctx.owner}: ${call.questions.map(shortQuestion).join(' · ')}`
    : who?.kind === 'owner' ? ` You asked ${ctx.owner}${what ? ` to: ${what}` : ' for a step'}.`
      : who ? ` You waited on ${who.name}${what ? `: ${what}` : ''}.`
        : planned ? ` You planned: ${planned}.` : ''
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

/** A time at the start of a Check line. */
const AT_START = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}\S*)\s*(?:·\s*)?(.*)$/

/** An Ask line's value as written: "[who] what · do · due YYYY-MM-DD", the kind and the due optional. Null without a [who]. */
export function readAskLine(value: string): Ask | null {
  const tagged = /^\[([^\]]+)\](?!\()\s*(.*)$/.exec(value.trim())
  if (!tagged) return null
  const parts = tagged[2].split(/\s+·\s+/)
  const ask: Ask = { who: tagged[1].trim(), what: '' }
  const what: string[] = []
  for (const part of parts) {
    const p = part.trim()
    const due = /^due\s+(\S+)$/i.exec(p)
    if ((ASK_KINDS as readonly string[]).includes(p.toLowerCase())) ask.kind = p.toLowerCase() as AskKind
    else if (due && isDue(due[1])) ask.due = due[1]
    else if (p) what.push(p)
  }
  ask.what = what.join(' · ')
  return ask
}

/** A Check line's value as written: "none", or "YYYY-MM-DDTHH:MM · why". Null when it is neither. */
export function readCheckLine(value: string): Check | 'none' | null {
  const v = value.trim()
  if (/^none\.?$/i.test(v)) return 'none'
  const timed = AT_START.exec(v)
  return timed ? { when: timed[1], why: timed[2].trim() } : null
}

/** A call as the "### Handoff" block: what goes into the task's journal. An older call's next is written as the ask and the check it stands for. */
export function handoffBlock(call: EndTurn, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): string {
  const L = HANDOFF_LABELS
  const verified = [call.checked && `${L.checked}: ${oneLine(call.checked)}`, call.claimed && `${L.claimed}: ${oneLine(call.claimed)}`].filter(Boolean).join(' · ')
  const { ask, check } = askAndCheckOf(call, ctx)
  const askLine = ask && [`[${writtenWho(ask.who, ctx)}] ${oneLine(ask.what)}`.trim(), ask.kind, ask.due && `due ${ask.due}`].filter(Boolean).join(' · ')
  // The journal keeps the why the agent wrote; one the cockpit wrote for it (checkPrompt) says nothing new.
  const ownWhy = call.check && call.check !== 'none' ? call.check.why : ''
  const checkLine = check === 'none' ? 'none' : check ? [check.when, ownWhy && oneLine(ownWhy)].filter(Boolean).join(' · ') : null
  return [
    `### ${L.heading}`,
    `${L.result}: ${oneLine(call.result)}`,
    call.failed && `${L.failed}: ${oneLine(call.failed)}`,
    verified,
    call.decided && `${L.decided}: ${oneLine(call.decided)}`,
    askLine && `${L.ask}: ${askLine}`,
    checkLine && `${L.check}: ${checkLine}`,
    ...(call.questions?.length ? [`${L.questions}:`, ...call.questions.map((q) => `- [${ctx.owner}] ${oneLine(q)}`)] : []),
  ].filter(Boolean).join('\n')
}

/**
 * A block a session wrote, as the call it stands for; null when it says nothing a call could hold. An Ask without a
 * [who] names nobody: no ask. A block of a session started before 0.25 has a Next line: it is kept as the call's
 * next, and read as the ask and the check it stands for (askAndCheckOf).
 */
export function fromHandoff(handoff: Handoff, ctx: Pick<TurnContext, 'owner' | 'agent' | 'members'>): EndTurn | null {
  const ask = handoff.ask?.who ? handoff.ask : null
  const step = !ask && !handoff.check && handoff.nextStep?.who ? handoff.nextStep : null
  const result = handoff.result ?? handoff.failed ?? handoff.forUser[0] ?? ask?.what ?? step?.what
  if (!result) return null
  const call: EndTurn = { result }
  if (ask) call.ask = { ...ask, who: writtenWho(ask.who, ctx) }
  if (handoff.check) call.check = handoff.check
  if (step?.who) call.next = { who: writtenWho(step.who, ctx), what: step.what, ...(step.when ? { when: step.when } : {}) }
  if (handoff.forUser.length > 0) call.questions = [...handoff.forUser]
  for (const key of ['failed', 'checked', 'claimed', 'decided'] as const) {
    const value = handoff[key]
    if (value) call[key] = value
  }
  return call
}
