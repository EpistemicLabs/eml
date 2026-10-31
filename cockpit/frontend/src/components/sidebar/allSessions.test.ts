import { describe, expect, it } from 'vitest';

import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo } from '@/stores/useTurnStateStore';
import { agentLetter, allSessionState, filterByName, groupAllSessions, type AllSession } from './allSessions';

const main: SpaceInfo = { id: 'main-id', name: 'Main', main: true, label: 'Alpha' };
const other: SpaceInfo = { id: 'other-id', name: 'Other', main: false, label: 'Beta' };
const spaces = [main, other];

const session = (id: string, fields: Partial<AllSession> = {}): AllSession => ({
  id,
  spaceId: main.id,
  state: 'detached',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastActivity: '2026-01-01T00:00:00.000Z',
  ...fields,
});
const turn = (state: TurnInfo['state']): TurnInfo => ({ state, since: '2026-01-02T00:00:00.000Z' });
const pinnedField = (s: { isPinned?: boolean }) => Boolean(s.isPinned);
const ids = (list: AllSession[]) => list.map((s) => s.id);

describe('groupAllSessions', () => {
  it('sorts sessions into waiting, pinned, working and recent', () => {
    const sections = groupAllSessions(
      [session('w'), session('p', { isPinned: true }), session('g'), session('r')],
      spaces,
      { w: turn('waiting'), g: turn('working'), r: turn('done') },
      pinnedField,
    );
    expect(ids(sections.waiting)).toEqual(['w']);
    expect(ids(sections.pinned[0].sessions)).toEqual(['p']);
    expect(ids(sections.working)).toEqual(['g']);
    expect(ids(sections.recent[0].sessions)).toEqual(['r']);
  });

  it('moves a waiting pinned session up without showing it twice, and brings it back afterwards', () => {
    const pinned = session('p', { isPinned: true });
    const whileWaiting = groupAllSessions([pinned], spaces, { p: turn('waiting') }, pinnedField);
    expect(ids(whileWaiting.waiting)).toEqual(['p']);
    expect(whileWaiting.pinned).toEqual([]);
    const afterwards = groupAllSessions([pinned], spaces, { p: turn('done') }, pinnedField);
    expect(afterwards.waiting).toEqual([]);
    expect(ids(afterwards.pinned[0].sessions)).toEqual(['p']);
  });

  it('keeps a working pinned session under pinned', () => {
    const sections = groupAllSessions([session('p', { isPinned: true })], spaces, { p: turn('working') }, pinnedField);
    expect(ids(sections.pinned[0].sessions)).toEqual(['p']);
    expect(sections.working).toEqual([]);
  });

  it('groups by agent in the order of the space list', () => {
    const sections = groupAllSessions([session('b', { spaceId: other.id }), session('a')], spaces, {}, pinnedField);
    expect(sections.recent.map((group) => group.space.id)).toEqual([main.id, other.id]);
  });

  it('keeps pinned rows in place when their activity changes, and sorts recent by activity', () => {
    const older = { createdAt: '2026-01-01T00:00:00.000Z', lastActivity: '2026-03-01T00:00:00.000Z' };
    const newer = { createdAt: '2026-02-01T00:00:00.000Z', lastActivity: '2026-02-02T00:00:00.000Z' };
    const pinned = groupAllSessions(
      [session('n', { ...newer, isPinned: true }), session('o', { ...older, isPinned: true })],
      spaces, {}, pinnedField,
    );
    expect(ids(pinned.pinned[0].sessions)).toEqual(['o', 'n']);
    const recent = groupAllSessions([session('n', newer), session('o', older)], spaces, {}, pinnedField);
    expect(ids(recent.recent[0].sessions)).toEqual(['o', 'n']);
  });

  it('keeps workers and finished sessions as ordinary recent rows', () => {
    const sections = groupAllSessions([session('w', { worker: true })], spaces, { w: turn('done') }, pinnedField);
    expect(ids(sections.recent[0].sessions)).toEqual(['w']);
  });
});

describe('allSessionState', () => {
  it('treats an ended session as idle whatever state the host still holds', () => {
    expect(allSessionState(session('x', { state: 'ended' }), turn('waiting'))).toBe('idle');
    expect(allSessionState(session('x', { state: 'ended' }), turn('working'))).toBe('idle');
  });

  it('prefers the live state over the one from the fetch', () => {
    expect(allSessionState(session('x', { turnState: 'working' }), turn('waiting'))).toBe('waiting');
    expect(allSessionState(session('x', { turnState: 'working' }), undefined)).toBe('working');
    expect(allSessionState(session('x'), undefined)).toBe('idle');
  });
});

describe('labels and search', () => {
  it('marks a session with the first letter of its agent, else of its space', () => {
    expect(agentLetter(main)).toBe('A');
    expect(agentLetter({ id: 'x', name: 'gamma', main: false })).toBe('G');
  });

  it('filters by name in any case; a blank query keeps everything', () => {
    const list = [session('a', { summary: 'Fix the Login' }), session('b', { summary: 'Other' }), session('c')];
    expect(ids(filterByName(list, 'login'))).toEqual(['a']);
    expect(ids(filterByName(list, '  '))).toEqual(['a', 'b', 'c']);
  });
});
