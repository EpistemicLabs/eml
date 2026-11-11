import { afterEach, describe, expect, it, vi } from 'vitest';
import { canOfferMove, fetchMovePlan, lostOutcome, movedMarker, moveOutcome, planText, runMove, targetOptions, type MovePlanView } from './move';
import type { Team } from './team';
import type { SpaceInfo } from '@/stores/useSpaceStore';

// Moving a project into a shared space as the UI reads it (lib/move.ts): the
// target chooser, the plan's sentences, what each answer of the run means, the
// moved marker of an archived project, and the two host calls.

const space = (id: string, extra: Partial<SpaceInfo> = {}): SpaceInfo => ({ id, name: id, main: false, agent: 'motti', upgrade: null, shared: false, ...extra });

const live: Team = { shared: true, brain: 'b', relay: 'wss://relay.example.com', mode: 'member', state: { kind: 'live' }, read_only: null, member: null, members: [], invites: [] };
const offline: Team = { ...live, state: { kind: 'offline' }, read_only: 'This shared brain takes no write right now: it is offline.' };

const plan = (extra: Partial<MovePlanView> = {}): MovePlanView => ({
  project: 'top', source: 'src', target: 'tgt', plan_hash: 'a'.repeat(64),
  tree: [{ id: 'top', engrams: 2 }],
  moved: { engrams: 2, entries: 1, relations: 1 },
  crossing: [],
  payload_bytes: 4.2 * 1024 * 1024,
  collisions: [],
  ...extra,
});

describe('the target chooser', () => {
  it('lists the shared spaces; one that takes no write shows its state and cannot be chosen; one not reported yet can', () => {
    const spaces = [space('main', { main: true }), space('team', { shared: true, name: 'EML team' }), space('off', { shared: true, name: 'Other' }), space('new', { shared: true })];
    expect(targetOptions(spaces, { team: live, off: offline })).toEqual([
      { id: 'team', name: 'EML team', label: 'EML team', enabled: true },
      { id: 'off', name: 'Other', label: 'Other — Not connected to the relay', enabled: false },
      { id: 'new', name: 'new', label: 'new', enabled: true },
    ]);
  });

  it('offers the move in a local space that has a shared space to move into, not in a shared space', () => {
    const shared = space('team', { shared: true });
    expect(canOfferMove(space('main', { main: true }), [shared])).toBe(true);
    expect(canOfferMove(space('main', { main: true }), [space('main', { main: true })])).toBe(false);
    expect(canOfferMove(shared, [shared])).toBe(false);
    expect(canOfferMove(null, [shared])).toBe(false);
  });
});

describe('the plan as the dialog says it', () => {
  it('one project: the counts, nothing dropped, the size', () => {
    expect(planText(plan(), 'EML', (id) => id)).toEqual({
      what: 'This moves EML: 2 engrams, 1 journal entry and 1 link between them.',
      projects: null,
      dropped: 'Nothing links out of this project.',
      links: [],
      size: 'Size: 4.2 MB of 16 MB.',
    });
  });

  it('with sub-projects: the tree by name, the dropped links by title and type', () => {
    const p = plan({
      tree: [{ id: 'top', engrams: 2 }, { id: 'child', engrams: 0 }],
      moved: { engrams: 2, entries: 0, relations: 0 },
      crossing: [
        { id: 'r1', relation: 'related_to', direction: 'out', other: { id: 'd1', type: 'decision', title: 'Keep the relay stateless' } },
        { id: 'r2', relation: 'refines', direction: 'in', other: { id: 'n1', type: 'note', title: null } },
      ],
    });
    const text = planText(p, 'EML', (id) => ({ top: 'EML', child: 'EML app' })[id] ?? id);
    expect(text.what).toBe('This moves EML with its sub-projects: 2 engrams, 0 journal entries and 0 links between them, in 2 projects.');
    expect(text.projects).toEqual([{ id: 'top', name: 'EML', engrams: 2 }, { id: 'child', name: 'EML app', engrams: 0 }]);
    expect(text.dropped).toBe('2 links to things that stay behind are dropped. They are kept in the backup.');
    expect(text.links).toEqual(['Keep the relay stateless (decision)', 'n1 (note)']);
    expect(planText(plan({ crossing: [p.crossing[0]] }), 'EML', (id) => id).dropped).toBe('1 link to things that stay behind is dropped. It is kept in the backup.');
    // a small set reads in whole KB, never "0.0 MB"
    expect(planText(plan({ payload_bytes: 3_900 }), 'EML', (id) => id).size).toBe('Size: 4 KB of 16 MB.');
    expect(planText(plan({ payload_bytes: 10 }), 'EML', (id) => id).size).toBe('Size: 1 KB of 16 MB.');
  });
});

describe('what the run answers', () => {
  it('done, with the backup path', () => {
    expect(moveOutcome({ status: 200, body: { backup_path: '/home/backups/move/src-now.db' } }, 'EML', 'EML team')).toEqual({
      kind: 'done', text: 'Moved. EML is now in EML team; the copy here is archived and points there.', backup: '/home/backups/move/src-now.db',
    });
  });

  it('a changed plan, a pending write, and every other answer in the server\'s or host\'s words', () => {
    expect(moveOutcome({ status: 409, body: { code: 'PLAN_CHANGED', error: 'move refused: the plan changed…' } }, 'EML', 'EML team')).toEqual({ kind: 'changed', text: 'The project changed since this plan was made. Here is the current one.' });
    expect(moveOutcome({ status: 504, body: { code: 'SHARED_WRITE_PENDING', error: '…may still land' } }, 'EML', 'EML team')).toEqual({
      kind: 'pending', text: 'The move was sent, but EML team did not confirm it in time. Nothing was removed here. Once EML team is connected again, Move picks up where it stopped.',
    });
    expect(moveOutcome({ status: 503, body: { code: 'SHARED_BRAIN_READ_ONLY', error: 'This shared brain takes no write right now: it is offline.' } }, 'EML', 'EML team')).toEqual({ kind: 'failed', text: 'This shared brain takes no write right now: it is offline.' });
    expect(moveOutcome({ status: 409, body: { code: 'MOVE_REFUSED', error: 'move refused: a move out of this brain is under way. Nothing was moved.' } }, 'EML', 'EML team')).toEqual({ kind: 'failed', text: 'move refused: a move out of this brain is under way. Nothing was moved.' });
    expect(moveOutcome({ status: 404, body: { error: { code: 'NO_SUCH_SPACE', message: 'No such brain space' } } }, 'EML', 'EML team')).toEqual({ kind: 'failed', text: 'No such brain space' });
    expect(moveOutcome({ status: 500, body: {} }, 'EML', 'EML team')).toEqual({ kind: 'failed', text: 'The move failed (500).' });
  });

  it('no answer at all: the move may have gone through', () => {
    expect(lostOutcome('EML')).toEqual({
      kind: 'lost', text: 'The connection broke off before the move answered, so it may have gone through. If it did, EML shows where it moved once you close this. If not, Move again: it picks up where it stopped.',
    });
  });
});

describe('the moved marker', () => {
  it('reads where an archived project went; nothing for a project that was not moved', () => {
    expect(movedMarker({ repo: 'r', moved_to: 'b', moved_at: '2026-11-04T01:00:00.000Z', moved_to_name: 'EML team' })).toEqual({ to: 'b', at: '2026-11-04T01:00:00.000Z', name: 'EML team' });
    expect(movedMarker({ moved_to: 'b', moved_at: '2026-11-04T01:00:00.000Z' })).toEqual({ to: 'b', at: '2026-11-04T01:00:00.000Z', name: null });
    expect(movedMarker({ repo: 'r' })).toBeNull();
    expect(movedMarker(null)).toBeNull();
  });
});

describe('the host calls', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('asks for the plan of one target and runs the move with the plan\'s hash', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
    await fetchMovePlan('bp-top', 'team');
    await runMove('bp-top', 'team', 'a'.repeat(64));
    expect(seen.map((s) => s.url)).toEqual(['/api/projects/bp-top/move-plan?target=team', '/api/projects/bp-top/move']);
    expect(seen[1].init?.method).toBe('POST');
    expect(JSON.parse(seen[1].init?.body as string)).toEqual({ target: 'team', plan_hash: 'a'.repeat(64) });
  });
});
