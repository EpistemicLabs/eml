// The line the chat shows where an agent ended its turn: the cockpit's end_turn call (or the older
// session_status) as one sentence, by the same first-match order the host derives the task's state from
// (host domain/turn-end.ts). No DOM in this module, so it is unit-tested as it is.
import { agentName, when } from '@/lib/task-board';

/** An end_turn call's input, as far as the line reads it. */
export interface EndTurnCall {
  kind: 'end_turn';
  result: string;
  next: { who: string; what: string; when: string | null } | null;
  questions: string[];
  failed: string | null;
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
}

export interface TurnEndLine {
  /** The state in a word or two: "Review", "Waiting on Dominik". */
  label: string;
  detail: string | null;
}

const said = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

/** A tool call that ends a turn, read tolerantly; null for any other tool and for a call the host refused. */
export function turnEndOfTool(tool: { name: string; input: Record<string, unknown>; status?: string }): TurnEndCall | null {
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
  };
}

const handle = (value: string | null | undefined): string => (value ?? '').trim().replace(/^@/, '').toLowerCase();
/** What an agent may call itself instead of its handle (host domain/turn-end.ts). */
const SELF = new Set(['me', 'self', 'agent']);
const OUTSIDE = /^outside:\s*/i;

const LEGACY_LABEL: Record<string, string> = { done: 'Done', question: 'Inbox', review: 'Review', failed: 'Failed' };

/**
 * What the line says. The first match wins: failed, questions, the owner's move, someone else's, the agent's own
 * check, done. Without the owner's handle a named who reads as "Waiting on <Name>", which holds for the owner too;
 * without the agent's handle only me / self / agent count as the agent itself.
 */
export function turnEndLine(call: TurnEndCall, ctx: TurnEndContext): TurnEndLine {
  if (call.kind === 'session_status') return { label: LEGACY_LABEL[call.status] ?? call.status, detail: call.reason };
  if (call.failed) return { label: 'Failed', detail: call.failed };
  if (call.questions.length > 0) return { label: 'Inbox', detail: `${call.questions.length} question${call.questions.length === 1 ? '' : 's'}` };
  const result = call.result || null;
  const { next } = call;
  if (!next) return { label: 'Done', detail: result };
  const who = handle(next.who);
  const at = next.when ? when(next.when, ctx.now) || next.when : null;
  if (SELF.has(who) || (!!handle(ctx.agent) && who === handle(ctx.agent))) {
    return at ? { label: 'Check scheduled', detail: at } : { label: 'Done', detail: result };
  }
  if (!OUTSIDE.test(next.who) && who === handle(ctx.owner)) return { label: 'Review', detail: result ?? (next.what || null) };
  const name = OUTSIDE.test(next.who) ? next.who.replace(OUTSIDE, '').trim() || 'someone outside' : agentName(who);
  return { label: `Waiting on ${name}`, detail: [next.what, at ? `checks ${at}` : ''].filter(Boolean).join(' · ') || null };
}

/** The line as one string: "Review · Draft is ready". */
export const turnEndText = (call: TurnEndCall, ctx: TurnEndContext): string => {
  const { label, detail } = turnEndLine(call, ctx);
  return detail ? `${label} · ${detail}` : label;
};
