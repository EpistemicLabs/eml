import { afterEach, describe, expect, it } from 'vitest';

import { setTimeZoneForTest } from '@/lib/time-zone';

import { turnEndLine, turnEndOfTool, type TurnEndCall, type TurnEndContext } from './turn-end-line';

// A Wednesday, local time.
const NOW = new Date(2026, 10, 25, 9, 0).getTime();
const ctx = { owner: 'kim', agent: 'nova', now: NOW };

const call = (input: Record<string, unknown>, name = 'mcp__cockpit__end_turn'): TurnEndCall => {
  const read = turnEndOfTool({ name, input, status: 'completed' });
  if (!read) throw new Error('not a call that ends a turn');
  return read;
};
/** The line as the chat shows it: "Review · Draft is ready". */
const text = (said: TurnEndCall, context: TurnEndContext): string => {
  const { label, detail } = turnEndLine(said, context);
  return detail ? `${label} · ${detail}` : label;
};
const line = (input: Record<string, unknown>, context: TurnEndContext = ctx) => text(call(input), context);

describe('turnEndOfTool', () => {
  it('reads end_turn and session_status, with or without the server prefix', () => {
    expect(turnEndOfTool({ name: 'end_turn', input: { result: 'Shipped' } })).toMatchObject({ kind: 'end_turn', result: 'Shipped', next: null, questions: [], failed: null });
    expect(turnEndOfTool({ name: 'mcp__cockpit__session_status', input: { status: 'review', reason: 'Look' } })).toEqual({ kind: 'session_status', status: 'review', reason: 'Look' });
  });

  it('leaves other tools, a status call without a status and a refused call alone', () => {
    expect(turnEndOfTool({ name: 'Read', input: { result: 'x' } })).toBeNull();
    expect(turnEndOfTool({ name: 'mcp__cockpit__session_status', input: {} })).toBeNull();
    expect(turnEndOfTool({ name: 'mcp__cockpit__end_turn', input: { result: 'x' }, status: 'failed' })).toBeNull();
  });

  it('a call the host refused (the tool answered as an error) is no end of the turn: it stays a failed tool row', () => {
    const refused = { name: 'mcp__cockpit__end_turn', input: { result: 'Sent', next: { who: 'me', what: 'look', when: '2020-01-01T10:00' } } };
    expect(turnEndOfTool({ ...refused, status: 'failed' })).toBeNull();
    expect(turnEndOfTool({ ...refused, status: 'completed' })).not.toBeNull();
    expect(turnEndOfTool({ name: 'mcp__cockpit__session_status', input: { status: 'done' }, status: 'failed' })).toBeNull();
  });

  it('drops what is not as the tool takes it: a next without who, empty questions', () => {
    expect(call({ result: 'x', next: { what: 'look' }, questions: ['', 3, ' One? '], failed: ' ' })).toEqual({ kind: 'end_turn', result: 'x', next: null, questions: ['One?'], failed: null, savedAt: null });
  });
});

describe('the line of an end_turn call', () => {
  it('failed comes first', () => {
    expect(line({ result: 'Stuck', failed: 'The build does not pass', questions: ['Go on?'], next: { who: 'kim', what: 'look' } })).toBe('Failed · The build does not pass');
  });

  it('questions go to the Inbox, counted', () => {
    expect(line({ result: 'Half done', questions: ['Which plan?'], next: { who: 'sam', what: 'answer' } })).toBe('Inbox · 1 question');
    expect(line({ result: 'Half done', questions: ['A?', 'B?', 'C?'] })).toBe('Inbox · 3 questions');
  });

  it('the owner next is a review of the result', () => {
    expect(line({ result: 'Draft is ready', next: { who: 'kim', what: 'Read the draft' } })).toBe('Review · Draft is ready');
    expect(line({ result: 'Draft is ready', next: { who: '@Kim', what: 'Read the draft', when: '2026-11-26T10:00' } })).toBe('Review · Draft is ready');
    expect(line({ result: '', next: { who: 'kim', what: 'Read the draft' } })).toBe('Review · Read the draft');
  });

  it('another member or agent next is a wait on them, with the check if one is set', () => {
    expect(line({ result: 'Sent over', next: { who: 'sam', what: 'Approve the budget' } })).toBe('Waiting on Sam · Approve the budget');
    expect(line({ result: 'Sent over', next: { who: 'echo', what: 'Run the import', when: '2026-11-26T10:00' } })).toBe('Waiting on Echo · Run the import · checks tomorrow 10:00');
  });

  it('someone outside is named without the prefix', () => {
    expect(line({ result: 'Mail sent', next: { who: 'outside:Acme GmbH', what: 'Sign the offer' } })).toBe('Waiting on Acme GmbH · Sign the offer');
    expect(line({ result: 'Mail sent', next: { who: 'outside: Jane', what: 'Reply', when: '2026-11-27T10:00' } })).toBe('Waiting on Jane · Reply · checks Fri 10:00');
    expect(line({ result: 'Mail sent', next: { who: 'outside:', what: 'Reply' } })).toBe('Waiting on someone outside · Reply');
    // Outside wins over a handle of the same name.
    expect(line({ result: 'Mail sent', next: { who: 'outside:kim', what: 'Reply' } })).toBe('Waiting on kim · Reply');
  });

  it('the agent itself next is a scheduled check, at a time written like the others in the app', () => {
    expect(line({ result: 'Deploy runs', next: { who: 'nova', what: 'See if it is up', when: '2026-11-26T10:00' } })).toBe('Check scheduled · tomorrow 10:00');
    expect(line({ result: 'Deploy runs', next: { who: 'me', what: 'See if it is up', when: '2026-11-25T15:30' } })).toBe('Check scheduled · 15:30');
    expect(line({ result: 'Deploy runs', next: { who: 'self', what: 'See if it is up', when: '2026-11-27T10:00' } })).toBe('Check scheduled · Fri 10:00');
    expect(line({ result: 'Deploy runs', next: { who: 'agent', what: 'See if it is up', when: '2026-12-14T10:00' } })).toBe('Check scheduled · 14 Dec 10:00');
    expect(line({ result: 'Deploy runs', next: { who: 'me', what: 'See if it is up', when: 'next week' } })).toBe('Check scheduled · next week');
  });

  it('everything else is done: no next, or the agent itself with no time', () => {
    expect(line({ result: 'Merged and deployed' })).toBe('Done · Merged and deployed');
    expect(line({ result: 'Merged', next: { who: 'nova', what: 'Nothing' } })).toBe('Done · Merged');
    expect(line({})).toBe('Done');
  });

  it('reads who by the words the host takes for the user and for the agent itself', () => {
    // user / owner are the owner, also on a page that does not know the owner's handle yet.
    for (const who of ['user', 'owner', 'User', '@owner']) {
      expect(line({ result: 'Draft is ready', next: { who, what: 'Read the draft' } }), who).toBe('Review · Draft is ready');
      expect(line({ result: 'Draft is ready', next: { who, what: 'Read the draft' } }, { now: NOW }), who).toBe('Review · Draft is ready');
    }
    for (const who of ['me', 'self', 'agent', 'myself', 'Myself']) {
      expect(line({ result: 'Runs', next: { who, what: 'Check', when: '2026-11-26T10:00' } }, { now: NOW }), who).toBe('Check scheduled · tomorrow 10:00');
    }
    // The owner comes before the agent, as on the host: an owner called "agent" is still the owner.
    expect(line({ result: 'Draft is ready', next: { who: 'agent', what: 'Read' } }, { now: NOW, owner: 'agent' })).toBe('Review · Draft is ready');
    // Someone outside by the prefix, whatever the name.
    expect(line({ result: 'Mail sent', next: { who: 'outside:user', what: 'Reply' } })).toBe('Waiting on user · Reply');
    expect(line({ result: 'Mail sent', next: { who: 'outside:me', what: 'Reply' } })).toBe('Waiting on me · Reply');
  });

  it('without the owner\'s handle a named who is a wait on them, never a review', () => {
    const unknown = { now: NOW, agent: 'nova' };
    expect(line({ result: 'Draft is ready', next: { who: 'kim', what: 'Read the draft' } }, unknown)).toBe('Waiting on Kim · Read the draft');
    expect(line({ result: 'Draft is ready', next: { who: 'kim', what: 'Read the draft' } }, { ...unknown, owner: '' })).toBe('Waiting on Kim · Read the draft');
    expect(line({ result: 'Draft is ready', questions: ['Go?'] }, unknown)).toBe('Inbox · 1 question');
  });

  it('without the agent\'s handle only me, self and agent are the agent itself', () => {
    const unknown = { now: NOW, owner: 'kim' };
    expect(line({ result: 'Runs', next: { who: 'self', what: 'Check', when: '2026-11-26T10:00' } }, unknown)).toBe('Check scheduled · tomorrow 10:00');
    expect(line({ result: 'Runs', next: { who: 'nova', what: 'Check', when: '2026-11-26T10:00' } }, unknown)).toBe('Waiting on Nova · Check · checks tomorrow 10:00');
  });
});

describe('the line of a session_status call', () => {
  const legacy = (status: string, reason?: string) => text(call({ status, ...(reason ? { reason } : {}) }, 'mcp__cockpit__session_status'), ctx);

  it('says the same words from its status and reason', () => {
    expect(legacy('question', 'Confirm the start date')).toBe('Inbox · Confirm the start date');
    expect(legacy('review', 'Draft is ready')).toBe('Review · Draft is ready');
    expect(legacy('failed', 'No access to the repo')).toBe('Failed · No access to the repo');
    expect(legacy('done', 'Merged')).toBe('Done · Merged');
  });

  it('stands alone without a reason, and keeps a status it does not know', () => {
    expect(legacy('done')).toBe('Done');
    expect(legacy('paused', 'Later')).toBe('paused · Later');
  });
});

describe('the check\'s time in the user\'s time zone (the tests run in UTC)', () => {
  afterEach(() => setTimeZoneForTest(null));
  // Wed 25 Nov 2026 13:00 UTC = 20:00 in Bangkok.
  const AT = Date.parse('2026-11-25T13:00:00Z');
  const own = { result: 'Deploy runs', next: { who: 'nova', what: 'See if it is up', when: '2026-11-25T20:15' } };
  const ANSWER = 'Recorded: you look again at 2026-11-25T20:15 (Asia/Bangkok, 2026-11-25T13:15Z). Now write your reply as visible text.';

  it('reads next.when in the user\'s zone, as the host does, and shows it there', () => {
    setTimeZoneForTest('Asia/Bangkok');
    expect(line(own, { ...ctx, now: AT })).toBe('Check scheduled · 20:15');
    // 18:00 UTC is 01:00 on the 26th in Bangkok: a check at 09:00 on the 26th is today there, though tomorrow in UTC.
    const early = { ...own, next: { ...own.next, when: '2026-11-26T09:00' } };
    expect(line(early, { ...ctx, now: Date.parse('2026-11-25T18:00:00Z') })).toBe('Check scheduled · 09:00');
    expect(line(early, { ...ctx, now: Date.parse('2026-11-25T18:00:00Z'), zone: 'UTC' })).toBe('Check scheduled · tomorrow 09:00');
  });

  it('shows the instant the host saved, from the tool\'s answer, in the user\'s zone: the same time the task panel shows', () => {
    const saved = turnEndOfTool({ name: 'mcp__cockpit__end_turn', input: own, status: 'completed', output: ANSWER });
    expect(saved?.kind === 'end_turn' && saved.savedAt).toBe('2026-11-25T13:15Z');
    // Even when the zone changed since: the saved instant counts, not the words.
    expect(text(saved!, { ...ctx, now: AT, zone: 'Asia/Makassar' })).toBe('Check scheduled · 21:15');
    expect(text(saved!, { ...ctx, now: AT, zone: 'UTC' })).toBe('Check scheduled · 13:15');
    // An answer without the instant (an older host) leaves the call's own time.
    const older = turnEndOfTool({ name: 'end_turn', input: own, output: 'Recorded: you look again at 2026-11-25T20:15.' });
    expect(older?.kind === 'end_turn' ? older.savedAt : 'not a call').toBeNull();
  });
});
