// The team of every shared space, as the host reports it (GET
// /api/spaces/:id/team, lib/team.ts): one poll for all subscribers, the
// active space every 3 s while the window is focused, the others every 30 s —
// enough for the dots on the space switch. The banner, the write controls
// (writable) and Settings › Spaces read it. Same module-store +
// useSyncExternalStore pattern as the other stores.
import { useSyncExternalStore } from 'react';
import * as paneStore from './usePaneStore';
import { getSpaces, useActiveSpace, useSpaces } from './useSpaceStore';
import { fetchTeam, writable as writableFor, type Team } from '@/lib/team';

const ACTIVE_MS = 3_000;
const OTHERS_MS = 30_000;

let teams: Record<string, Team> = {};
const listeners = new Set<() => void>();
let timer: number | null = null;
let lastOthers = 0;

const notify = () => { for (const listener of listeners) listener(); };

/** The pane store keys main as null; the space list keys it by id. */
function activeId(): string | null {
  const key = paneStore.getActiveSpaceId();
  return key ?? getSpaces().find((s) => s.main)?.id ?? null;
}

async function loadOne(spaceId: string): Promise<void> {
  try {
    const answer = await fetchTeam(spaceId);
    if (answer.status !== 200 || typeof answer.body.shared !== 'boolean') return;
    teams = { ...teams, [spaceId]: answer.body };
    notify();
  } catch { /* host unreachable: keep the last state */ }
}

/** The active shared space every tick; the other shared spaces when their interval is up. */
async function tick(force = false): Promise<void> {
  const shared = getSpaces().filter((s) => s.shared);
  if (shared.length === 0) return;
  const active = activeId();
  const others = force || Date.now() - lastOthers >= OTHERS_MS;
  if (others) lastOthers = Date.now();
  await Promise.all(shared.filter((s) => s.id === active || others).map((s) => loadOne(s.id)));
}

const onFocus = () => void tick(true);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    void tick(true);
    timer = window.setInterval(() => { if (document.hasFocus()) void tick(); }, ACTIVE_MS);
    window.addEventListener('focus', onFocus);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      window.removeEventListener('focus', onFocus);
    }
  };
};

/** Read again now (after an action, a space change, a new shared space). */
export const refreshTeams = (): Promise<void> => tick(true);

/** The team of one space; undefined until the host answered or for a local space. */
export function useTeam(spaceId: string | null | undefined): Team | undefined {
  const all = useSyncExternalStore(subscribe, () => teams);
  return spaceId ? all[spaceId] : undefined;
}

export function useTeams(): Record<string, Team> {
  return useSyncExternalStore(subscribe, () => teams);
}

/**
 * Whether the UI may write to a space's brain, and the server's reason when
 * not — the one helper every write control reads (decision: writes do not fail
 * where they happen; one state decides). The active space's, unless a control
 * shows something of another one (All spaces).
 */
export function useWritable(spaceId?: string): { writable: boolean; reason: string | null } {
  const active = useActiveSpace();
  const spaces = useSpaces();
  const space = spaces.find((s) => s.id === spaceId) ?? active;
  const team = useTeam(space?.id);
  return writableFor(space?.shared ?? false, team);
}
