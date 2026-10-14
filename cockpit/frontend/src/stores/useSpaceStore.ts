// The brain spaces this cockpit works with (host: brain-space.ts, GET
// /api/spaces). The ACTIVE space lives in the pane store with the desks (a
// desk belongs to a space); this store holds the list — names, which one is
// main — and the two actions: switch and create. Same module-store +
// useSyncExternalStore pattern as the other stores.
import { useSyncExternalStore } from 'react';
import * as paneStore from './usePaneStore';

export interface SpaceInfo {
  id: string;
  name: string;
  main: boolean;
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
    const body = (await res.json()) as { spaces?: SpaceInfo[] };
    spaces = (body.spaces ?? []).filter((s) => typeof s.id === 'string' && typeof s.name === 'string');
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

export async function createSpace(name: string): Promise<{ space: SpaceInfo } | { error: string }> {
  const res = await fetch('/api/spaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => ({}))) as { space?: SpaceInfo; error?: { message?: string } };
  if (!res.ok || !body.space) return { error: body.error?.message ?? `Could not create the space (${res.status}).` };
  await loadSpaces();
  return { space: body.space };
}

/** Rename a space (display name; the brain keeps its name). */
export async function renameSpace(space: SpaceInfo, name: string): Promise<{ space: SpaceInfo } | { error: string }> {
  const res = await fetch(`/api/spaces/${encodeURIComponent(space.id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const body = (await res.json().catch(() => ({}))) as { space?: SpaceInfo; error?: { message?: string } };
  if (!res.ok || !body.space) return { error: body.error?.message ?? `Could not rename the space (${res.status}).` };
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
