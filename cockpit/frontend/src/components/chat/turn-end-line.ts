// The line the chat shows where an agent ended its turn: the cockpit's end_turn call (or the older
// session_status) as one sentence, by the same first-match order the host derives the task's state from
// (host domain/turn-end.ts). No DOM in this module, so it is unit-tested as it is.
import { agentName, when } from '@/lib/task-board';
import { parseInZone, userTimeZone } from '@/lib/time-zone';

/** An end_turn call's input, as far as the line reads it. */
export interface EndTurnCall {
  kind: 'end_turn';
  result: string;
  next: { who: string; what: string; when: string | null } | null;
  questions: string[];
  failed: string | null;
  /** The instant the host saved the check for, from the tool's answer (host domain/turn-end.ts savedAs); null when it names none. */
  savedAt: string | null;
}

/** A session_status call: what sessions started before end_turn still send. */
export interface LegacyStatusCall {
  kind: 'session_status';
  status: string;
  reason: string | null;
}

export type TurnEndCall = EndTurnCall | LegacyStatusCall;

/** Who the line is read by and written about. A handle the page does not know yet is left out. */
export interface TurnEndContext {
  /** The user's handle (the board's viewer). */
  owner?: string | null;
  /** The handle of the agent the session runs as (its space's agent). */
  agent?: string | null;
  now: number;
  /** The user's time zone; the setting (lib/time-zone.ts) when left out. */
  zone?: string;
}

export interface TurnEndLine {
  /** The state in a word or two: "Review", "Waiting on Kim". */
  label: string;
  detail: string | null;
}

const said = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** The host's answer names the zone a when was read in and the instant it saved: "… look again at 2026-11-26T20:15 (Asia/Bangkok, 2026-11-26T13:15Z)". */
const SAVED_AT = /look again at \S+ \([^,()]+, (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z)\)/;

/** A tool call that ends a turn, read tolerantly; null for any other tool and for a call the host refused. */
export function turnEndOfTool(tool: { name: string; input: Record<string, unknown>; status?: string; output?: string }): TurnEndCall | null {
  // A refused call recorded nothing: it stays an ordinary failed tool row.
  if (tool.status === 'failed') return null;
  if (/(^|__)session_status$/.test(tool.name)) {
    return typeof tool.input.status === 'string' ? { kind: 'session_status', status: tool.input.status, reason: said(tool.input.reason) || null } : null;
  }
  if (!/(^|__)end_turn$/.test(tool.name)) return null;
  const { next, questions } = tool.input;
  const step = next && typeof next === 'object' ? (next as Record<string, unknown>) : null;
  const who = said(step?.who);
  return {
    kind: 'end_turn',
    result: said(tool.input.result),
    next: step && who ? { who, what: said(step.what), when: said(step.when) || null } : null,
    questions: Array.isArray(questions) ? questions.map(said).filter(Boolean) : [],
    failed: said(tool.input.failed) || null,
    savedAt: SAVED_AT.exec(tool.output ?? '')?.[1] ?? null,
  };
}

/**
 * When the check is, as the line says it: the instant the host saved, else the call's when read in the user's
 * zone the way the host reads it; shown in that zone, so the chat and the task panel name the same time.
 */
function checkTime(call: EndTurnCall, now: number, zone: string): string | null {
  const written = call.next?.when;
  if (!written) return null;
  const at = call.savedAt ? Date.parse(call.savedAt) : parseInZone(written, zone);
  return at !== null && Number.isFinite(at) ? when(new Date(at).toISOString(), now, zone) || written : written;
}

const handle = (value: string | null | undefined): string => (value ?? '').trim().replace(/^@/, '').toLowerCase();
/** What an agent may call itself, and the user, instead of a handle: the host's lists (domain/turn-end.ts whoOf). */
const SELF = new Set(['me', 'self', 'agent', 'myself']);
const OWNER = new Set(['user', 'owner']);
const OUTSIDE = /^outside:\s*/i;

const LEGACY_LABEL: Record<string, string> = { done: 'Done', question: 'Inbox', review: 'Review', failed: 'Failed' };

/**
 * What the line says. The first match wins: failed, questions, the owner's move, the agent's own check, someone
 * else's move, done. A who is read as the host reads it (whoOf): someone outside by the prefix, then the owner (their
 * handle, or user / owner), then the agent itself (its handle, or me / self / agent / myself), then anyone else.
 * Without the owner's handle a named who reads as "Waiting on <Name>", which holds for the owner too; without the
 * agent's handle only the words for itself count as the agent.
 */
export function turnEndLine(call: TurnEndCall, ctx: TurnEndContext): TurnEndLine {
  if (call.kind === 'session_status') return { label: LEGACY_LABEL[call.status] ?? call.status, detail: call.reason };
  if (call.failed) return { label: 'Failed', detail: call.failed };
  if (call.questions.length > 0) return { label: 'Inbox', detail: `${call.questions.length} question${call.questions.length === 1 ? '' : 's'}` };
  const result = call.result || null;
  const { next } = call;
  if (!next) return { label: 'Done', detail: result };
  const who = handle(next.who);
  const outside = OUTSIDE.test(next.who);
  const at = checkTime(call, ctx.now, ctx.zone ?? userTimeZone());
  if (!outside && (OWNER.has(who) || (!!handle(ctx.owner) && who === handle(ctx.owner)))) return { label: 'Review', detail: result ?? (next.what || null) };
  if (!outside && (SELF.has(who) || (!!handle(ctx.agent) && who === handle(ctx.agent)))) {
    return at ? { label: 'Check scheduled', detail: at } : { label: 'Done', detail: result };
  }
  const name = outside ? next.who.replace(OUTSIDE, '').trim() || 'someone outside' : agentName(who);
  return { label: `Waiting on ${name}`, detail: [next.what, at ? `checks ${at}` : ''].filter(Boolean).join(' · ') || null };
}
