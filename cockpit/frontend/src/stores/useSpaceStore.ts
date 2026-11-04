// The brain spaces this cockpit works with (host: brain-space.ts, GET
// /api/spaces). The ACTIVE space lives in the pane store with the desks (a
// desk belongs to a space); this store holds the list — names, which one is
// main, which are shared — and the actions: switch, create (a local brain, a
// shared brain, a join by invite link), rename, remove. Same module-store +
// useSyncExternalStore pattern as the other stores.
import { useSyncExternalStore } from 'react';
import * as paneStore from './usePaneStore';
import { errorText, removeSpace as removeOnHost } from '@/lib/team';

export interface SpaceInfo {
  id: string;
  name: string;
  main: boolean;
  /** The agent bound to this space (its sessions run as it), null while none is bound. */
  agent: string | null;
  /** Why none is bound: the agent upgrade's reason, its report folder, and what it waits for. */
  upgrade: { reason: string; report: string | null; needs?: 'handle' } | null;
  /** v0.21: a shared brain; null when the host could not ask the brain server. */
  shared: boolean | null;
}

let spaces: SpaceInfo[] = [];
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const notify = () => { for (const listener of listeners) listener(); };

export function getSpaces(): SpaceInfo[] {
  return spaces;
}

/** The pane store's key for a space: null for main. */
export const paneSpaceKey = (space: SpaceInfo): string | null => (space.main ? null : space.id);

export async function loadSpaces(): Promise<SpaceInfo[]> {
  try {
    const res = await fetch('/api/spaces');
    if (!res.ok) return spaces;
    const body = (await res.json()) as { spaces?: Array<Partial<SpaceInfo>> };
    spaces = (body.spaces ?? [])
      .filter((s): s is SpaceInfo & Partial<SpaceInfo> => typeof s.id === 'string' && typeof s.name === 'string')
      .map((s) => ({
        id: s.id, name: s.name, main: s.main === true,
        agent: typeof s.agent === 'string' ? s.agent : null,
        upgrade: s.upgrade && typeof s.upgrade === 'object' ? s.upgrade : null,
        shared: typeof s.shared === 'boolean' ? s.shared : null,
      }));
    // A persisted active space the host no longer knows → back to main.
    const active = paneStore.getActiveSpaceId();
    if (active && !spaces.some((s) => s.id === active)) paneStore.activateSpace(null);
    notify();
  } catch { /* host unreachable — the list stays */ }
  return spaces;
}

/** Fired on window after the active space changed (AppContent); data hooks refetch on it. */
export const SPACE_CHANGED_EVENT = 'cockpit-space-changed';

/** Show a space (its desks). The data refresh follows the active space in AppContent. */
export function switchSpace(space: SpaceInfo): void {
  paneStore.activateSpace(paneSpaceKey(space));
}

async function postSpace(payload: Record<string, unknown>, fallback: (status: number) => string): Promise<{ space: SpaceInfo } | { error: string }> {
  const res = await fetch('/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json().catch(() => ({}))) as { space?: SpaceInfo };
  if (!res.ok || !body.space) return { error: errorText(body, fallback(res.status)) };
  await loadSpaces();
  return { space: body.space };
}

export function createSpace(name: string): Promise<{ space: SpaceInfo } | { error: string }> {
  return postSpace({ name }, (status) => `Could not create the space (${status}).`);
}

/** v0.21: a new shared brain on the relay, through the EML account's grant (host team-space.ts). */
export function createSharedSpace(name: string): Promise<{ space: SpaceInfo } | { error: string }> {
  return postSpace({ name, shared: {} }, (status) => `Could not create the shared space (${status}).`);
}

/**
 * v0.21: join a shared brain with its invite link. A link for a brain this
 * cockpit has already (a new link after a join that stopped) goes to that
 * space; the name is then the space's own.
 */
export function joinSharedSpace(name: string, link: string): Promise<{ space: SpaceInfo } | { error: string }> {
  return postSpace({ name, join: { link } }, (status) => `Could not join the shared space (${status}).`);
}

/** v0.21: remove a shared space that never came to life (host DELETE /api/spaces/:id). */
export async function removeSpace(space: SpaceInfo): Promise<{ removed: true } | { error: string }> {
  const answer = await removeOnHost(space.id);
  if (answer.status !== 204) return { error: errorText(answer.body, `Could not remove the space (${answer.status}).`) };
  if (paneStore.getActiveSpaceId() === space.id) paneStore.activateSpace(null);
  await loadSpaces();
  return { removed: true };
}

/** Rename a space (display name; the brain keeps its name). */
export async function renameSpace(space: SpaceInfo, name: string): Promise<{ space: SpaceInfo } | { error: string }> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(space.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => ({}))) as { space?: SpaceInfo };
  if (!res.ok || !body.space) return { error: errorText(body, `Could not rename the space (${res.status}).`) };
  await loadSpaces();
  return { space: body.space };
}

export function useSpaces(): SpaceInfo[] {
  return useSyncExternalStore(subscribe, getSpaces);
}

/** The active space's info (main while the list has not loaded). */
export function useActiveSpace(): SpaceInfo | null {
  const key = paneStore.useActiveSpaceId();
  const list = useSpaces();
  return (key ? list.find((s) => s.id === key) : list.find((s) => s.main)) ?? null;
}
