import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cancelInvite, confirmJoin, createInvite, deadJoin, errorText, fetchTeam, joinStep, relayHost, removeSpace, stateTitle, stateTone, writable,
  type TeamSnapshot,
} from './team';

// A shared space's team as the UI reads it (lib/team.ts): the titles per
// state, the one writable() rule every write control follows, the error text
// of both answer shapes the host sends, and the calls to the host's routes.

const snapshot = (state: TeamSnapshot['state'], extra: Partial<TeamSnapshot> = {}): TeamSnapshot => ({
  shared: true,
  brain: '0f7c2b8e-4d3a-4c1b-9a6e-2b5d8f1e3c7a',
  relay: 'wss://relay.example.com',
  mode: 'member',
  state,
  read_only: state.kind === 'live' ? null : 'This shared brain takes no write right now: it is offline.',
  member: null,
  members: [],
  invites: [],
  ...extra,
});

describe('the state as the UI titles it', () => {
  it('has a title for every state but live, and the join step as the detail', () => {
    expect(stateTitle(snapshot({ kind: 'live' }))).toBeNull();
    expect(stateTitle(snapshot({ kind: 'joining', waiting: 'accept' }))).toBe('Joining the shared brain…');
    expect(stateTitle(snapshot({ kind: 'offline' }))).toBe('Not connected to the relay');
    expect(stateTitle(snapshot({ kind: 'catching_up' }))).toBe('Catching up with the relay…');
    expect(stateTitle(snapshot({ kind: 'waiting_key', epoch: 2 }))).toBe('Waiting for a brain key');
    expect(stateTitle(snapshot({ kind: 'stopped', why: 'x' }))).toBe('This shared brain stopped');
    expect(stateTitle(snapshot({ kind: 'stopped', why: 'x' }, { mode: 'join' }))).toBe('This join did not go through.');
    expect(stateTitle(snapshot({ kind: 'update_needed', why: 'x' }))).toBe('Update the cockpit to use this shared brain');
    expect(joinStep({ kind: 'joining', waiting: 'relay' })).toBe('Sending the join to the relay…');
    expect(joinStep({ kind: 'joining', waiting: 'accept' })).toBe('Waiting for the owner to confirm your join.');
    expect(joinStep({ kind: 'joining', waiting: 'membership' })).toBe('Confirmed — waiting for your membership to be recorded.');
    expect(joinStep({ kind: 'joining', waiting: 'key' })).toBe('Receiving the brain key…');
    expect(joinStep({ kind: 'offline' })).toBeNull();
  });

  it('is amber while something is under way and red when it is broken; a stopped join is dead', () => {
    expect(stateTone({ kind: 'joining', waiting: 'key' })).toBe('info');
    expect(stateTone({ kind: 'catching_up' })).toBe('info');
    expect(stateTone({ kind: 'waiting_key', epoch: 1 })).toBe('info');
    expect(stateTone({ kind: 'offline' })).toBe('destructive');
    expect(stateTone({ kind: 'stopped', why: 'x' })).toBe('destructive');
    expect(stateTone({ kind: 'update_needed', why: 'x' })).toBe('destructive');
    expect(deadJoin(snapshot({ kind: 'stopped', why: 'x' }, { mode: 'join' }))).toBe(true);
    expect(deadJoin(snapshot({ kind: 'stopped', why: 'x' }))).toBe(false);
    expect(deadJoin(snapshot({ kind: 'joining', waiting: 'accept' }, { mode: 'join' }))).toBe(false);
  });

  it('names the relay by its host', () => {
    expect(relayHost('wss://relay.example.com')).toBe('relay.example.com');
    expect(relayHost('wss://127.0.0.1:8787')).toBe('127.0.0.1:8787');
    expect(relayHost(null)).toBeNull();
  });
});

describe('writable', () => {
  it('a local space always; a shared one while the server reports it live, else with the server\'s reason', () => {
    expect(writable(false, undefined)).toEqual({ writable: true, reason: null });
    expect(writable(false, snapshot({ kind: 'offline' }))).toEqual({ writable: true, reason: null });
    expect(writable(true, undefined)).toEqual({ writable: true, reason: null });
    expect(writable(null, undefined)).toEqual({ writable: true, reason: null });
    expect(writable(true, { shared: false })).toEqual({ writable: true, reason: null });
    expect(writable(true, snapshot({ kind: 'live' }))).toEqual({ writable: true, reason: null });
    const offline = snapshot({ kind: 'offline' });
    expect(writable(true, offline)).toEqual({ writable: false, reason: offline.read_only });
    expect(writable(true, snapshot({ kind: 'joining', waiting: 'accept' }))).toMatchObject({ writable: false });
  });
});

describe('errorText', () => {
  it('reads the host\'s {error: {message}} and the server\'s {error: string} alike', () => {
    expect(errorText({ error: { code: 'NOT_SIGNED_IN', message: 'Sign in to your EML account first.' } }, 'x')).toBe('Sign in to your EML account first.');
    expect(errorText({ error: 'Invalid link.', code: 'INVALID_INVITE' }, 'x')).toBe('Invalid link.');
    expect(errorText({ error: '' }, 'fallback')).toBe('fallback');
    expect(errorText({}, 'fallback')).toBe('fallback');
    expect(errorText(null, 'fallback')).toBe('fallback');
  });
});

describe('the calls to the host', () => {
  const seen: Array<{ url: string; method: string; body: unknown }> = [];
  const answer = (status: number, body: unknown) => {
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response(body === null ? null : JSON.stringify(body), { status });
    });
  };
  afterEach(() => { vi.unstubAllGlobals(); seen.length = 0; });

  it('reads the team, makes an invite for a role, confirms and cancels, removes the space', async () => {
    const space = '0f7c2b8e-4d3a-4c1b-9a6e-2b5d8f1e3c7a';
    answer(200, { shared: false });
    expect(await fetchTeam(space)).toEqual({ status: 200, body: { shared: false } });
    answer(201, { invite_id: 'inv', link: 'https://relay.example.com/i/1/x/inv#secret', expires_at: 'later' });
    expect((await createInvite(space, 'owner')).body.link).toBe('https://relay.example.com/i/1/x/inv#secret');
    answer(200, { member: { handle: 'lasse' } });
    expect((await confirmJoin(space, 'inv')).status).toBe(200);
    answer(404, { error: 'No such invite.', code: 'NO_SUCH_INVITE' });
    expect(await cancelInvite(space, 'inv')).toEqual({ status: 404, body: { error: 'No such invite.', code: 'NO_SUCH_INVITE' } });
    answer(204, null);
    expect(await removeSpace(space)).toEqual({ status: 204, body: {} });
    expect(seen.map((c) => [c.method, c.url, c.body])).toEqual([
      ['GET', `/api/spaces/${space}/team`, undefined],
      ['POST', `/api/spaces/${space}/invites`, { role: 'owner' }],
      ['POST', `/api/spaces/${space}/invites/inv/accept`, {}],
      ['POST', `/api/spaces/${space}/invites/inv/cancel`, {}],
      ['DELETE', `/api/spaces/${space}`, undefined],
    ]);
  });

  it('a body that is not JSON becomes the error text', async () => {
    vi.stubGlobal('fetch', async () => new Response('Bad Gateway', { status: 502 }));
    const answer = await fetchTeam('x');
    expect(answer.status).toBe(502);
    expect(errorText(answer.body, 'fallback')).toBe('Bad Gateway');
  });
});
