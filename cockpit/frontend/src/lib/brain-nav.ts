// Page navigation for the brain views — a module store keyed per SURFACE
// (the header Brain tab, later each brain pane), not URL routes: every
// surface shares the one browser URL, and the engram drawer already owns
// `?engram=` (lib/engram-panel.ts). Same useSyncExternalStore pattern as
// stores/useTopViewStore.ts. Never add <Routes> for this — the desk layout
// would remount on URL changes.
import { useSyncExternalStore } from 'react';

export type BrainLoc =
  | { view: 'dashboard' }
  | { view: 'project'; projectId: string }
  | { view: 'search'; q: string };

type SurfaceState = {
  loc: BrainLoc;
  /** Back history (most recent last). */
  stack: BrainLoc[];
  persist: boolean;
};

const DASHBOARD: BrainLoc = { view: 'dashboard' };
const STORAGE_PREFIX = 'cockpit-brain-nav:';

const surfaces = new Map<string, SurfaceState>();
const listeners = new Set<() => void>();

const emit = () => { for (const listener of listeners) listener(); };
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const isLoc = (value: unknown): value is BrainLoc => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (v.view === 'dashboard') return true;
  if (v.view === 'project') return typeof v.projectId === 'string' && v.projectId.length > 0;
  if (v.view === 'search') return typeof v.q === 'string';
  return false;
};

function load(surfaceId: string): BrainLoc | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + surfaceId);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return isLoc(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function save(surfaceId: string, state: SurfaceState): void {
  if (!state.persist) return;
  try { localStorage.setItem(STORAGE_PREFIX + surfaceId, JSON.stringify(state.loc)); } catch { /* non-fatal */ }
}

/**
 * Register a surface (idempotent). A persisted surface resumes where it was;
 * anything else starts at `initial`.
 */
export function initSurface(surfaceId: string, initial: BrainLoc = DASHBOARD, persist = false): void {
  if (surfaces.has(surfaceId)) return;
  const loc = (persist && load(surfaceId)) || initial;
  surfaces.set(surfaceId, { loc, stack: [], persist });
}

export function getLoc(surfaceId: string): BrainLoc {
  return surfaces.get(surfaceId)?.loc ?? DASHBOARD;
}

export function canGoBack(surfaceId: string): boolean {
  return (surfaces.get(surfaceId)?.stack.length ?? 0) > 0;
}

/** Navigate forward: the current location goes onto the back stack. */
export function go(surfaceId: string, loc: BrainLoc): void {
  const state = surfaces.get(surfaceId);
  if (!state) return;
  state.stack.push(state.loc);
  state.loc = loc;
  save(surfaceId, state);
  emit();
}

/** Swap the current location without touching the back stack (refining a search). */
export function replace(surfaceId: string, loc: BrainLoc): void {
  const state = surfaces.get(surfaceId);
  if (!state) return;
  state.loc = loc;
  save(surfaceId, state);
  emit();
}

/** Pop the back stack; with nothing to pop, land on the dashboard. */
export function back(surfaceId: string): void {
  const state = surfaces.get(surfaceId);
  if (!state) return;
  state.loc = state.stack.pop() ?? DASHBOARD;
  save(surfaceId, state);
  emit();
}

/** Jump somewhere and forget the history (e.g. clicking the Brain tab again). */
export function reset(surfaceId: string, loc: BrainLoc = DASHBOARD): void {
  const state = surfaces.get(surfaceId);
  if (!state) return;
  state.loc = loc;
  state.stack = [];
  save(surfaceId, state);
  emit();
}

export function useSurfaceLoc(surfaceId: string): BrainLoc {
  return useSyncExternalStore(subscribe, () => getLoc(surfaceId));
}
