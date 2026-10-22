/**
 * Multi-pane / multi-desk layout store.
 *
 * No chat pane (the terminal IS the chat — see decision cockpit-pane-types),
 * no sub-panes / editor / todos / plugin tabs. Projects are the host's
 * project registry (decision cockpit-isolation-scope-clarified). What stays is the model that carries the shell: Desks →
 * Panes, a session id per terminal pane, per-session view memory,
 * persistence with validation, cross-tab sync, and the pending-shell-command
 * queue for externally spawned panes.
 *
 * The cockpit is organised into **desks** (top-level tabs). Each desk
 * owns its own set of panes + active pane, so terminals opened in one
 * desk never appear in another. A desk carries a stable `slug` (the
 * durable, skill-facing identifier used to route spawns at it) plus a
 * display `name` and an optional `defaultProjectId` that new/spawned panes
 * in that desk inherit.
 *
 * Each pane has its own (projectId, sessionId, paneView). Module-scope state +
 * useSyncExternalStore so every pane (and every consumer that reads
 * active-pane context) subscribes to the same source. No external store
 * dependency.
 *
 * The full layout (desks + panes + active ids) survives reloads via
 * localStorage. If the persisted blob is corrupt or empty we fall back to a
 * single default desk with one pane — never leave the user with zero panes.
 */
import type { LLMProvider } from '@/types/app';
import { useCallback, useSyncExternalStore } from 'react';
import { setTopView } from './useTopViewStore';

/**
 * Primary view mode for a pane's body. Mutually exclusive.
 *
 * Terminal mode hosts the embedded Claude CLI (xterm.js + node-pty), which
 * the host's pty-bridge resumes against the pane's session id. Brain mode
 * renders the local brain's views (graph / timeline / list). Note mode edits
 * one `type=note` engram of the pane's project (decision cockpit-notes-pane).
 */
export type PaneView = 'terminal' | 'brain' | 'note';

export const PANE_VIEWS: ReadonlyArray<PaneView> = ['terminal', 'brain', 'note'];

const isPaneView = (value: unknown): value is PaneView =>
  typeof value === 'string' && (PANE_VIEWS as readonly string[]).includes(value);

export interface PaneState {
  id: string;
  /** The host-registered project this pane's session runs in (cwd). */
  projectId: string | null;
  /**
   * The Claude session this pane owns. Pre-minted (UUID) the moment a
   * terminal pane is created — Claude's CLI accepts `--session-id <uuid>`,
   * so the pane owns the id up front and the host can `--resume` it later
   * (see decision cockpit-session-resume-strategy). Brain panes carry null.
   */
  sessionId: string | null;
  paneView: PaneView;
  /**
   * Auto-assigned label for terminal panes ("Terminal 1", "Terminal 2", …)
   * so multiple terminals are distinguishable in the pane title. Only set
   * while `paneView === 'terminal'`; cleared on toggle to brain. Numbers are
   * recycled when a labelled pane closes, scoped per-desk.
   */
  label?: string;
  /**
   * User-chosen pane title (inline rename). Overrides the auto `label` for
   * display and persists with the layout so a renamed terminal survives
   * reload. Empty/cleared → falls back to the auto label.
   */
  title?: string;
  /**
   * Pinned panes are kept first in their desk and can't be closed
   * (`onClosePane` is suppressed). Used for a long-lived orchestrator
   * terminal that should always be present in its desk while worker panes
   * come and go around it.
   */
  pinned?: boolean;
  /**
   * The note engram a note pane shows. Unset → the pane lists the project's
   * notes to pick from. Kept while the pane shows another view, so toggling
   * back to Note returns to the same note.
   */
  noteId?: string;
  /**
   * v0.17: the brain task this pane's session advances (a task run, skill
   * task-run). Sent with the terminal's init so the host ledger records it.
   */
  taskId?: string;
  /**
   * The agent CLI a NEW session in this pane starts with (a host provider
   * id); unset → the cockpit's default. Sent with the terminal's init. The
   * host records it with the session, so it only matters on the first spawn
   * and is dropped when the pane moves on to another session.
   */
  provider?: LLMProvider;
}

export interface DeskState {
  id: string;
  /**
   * The brain space the desk belongs to (decision cockpit-naming-desks-spaces):
   * a brain id, or null for the main space (desks from before spaces carry
   * none). Every pane and session on the desk works in that space.
   */
  spaceId: string | null;
  /**
   * Stable, lowercase identifier (e.g. "dev", "research"). Durable across
   * renames — this is what task runs target (`task-<title>`)
   * and what UI/routing keys off. Unique within the snapshot.
   */
  slug: string;
  /** Display name shown in the desk tab bar. */
  name: string;
  /**
   * New panes and slug-routed spawns in this desk inherit this project
   * when the caller doesn't specify one. Lets a dedicated desk default
   * everything to one repo.
   */
  defaultProjectId: string | null;
  panes: PaneState[];
  activePaneId: string;
}

interface PaneStoreSnapshot {
  desks: DeskState[];
  activeDeskId: string;
  /** The space of the active desk — the space the cockpit shows (null = main). */
  activeSpaceId: string | null;
  /**
   * Per-session view-mode memory: when a session is loaded into a pane
   * and an entry exists here, the pane snaps to that view. Shared across
   * all desks (a session's preferred view is the same wherever it opens).
   */
  sessionViews: Record<string, PaneView>;
}

const STORAGE_KEY = 'cockpit-pane-layout';

const generateId = (): string =>
  `pane-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const generateDeskId = (): string =>
  `desk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Every terminal pane mints its own session id at birth — the cockpit's id of
// the session. Claude Code adopts it (--session-id); Codex assigns its own and
// the host binds the two (session-ledger.ts, providerSessionId).
export const newCliSessionId = (): string => crypto.randomUUID();

const slugify = (input: string): string =>
  input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'desk';

const TERMINAL_LABEL_RE = /^Terminal (\d+)$/;

/**
 * Ensure every terminal pane has a unique `Terminal N` label and no brain
 * pane carries one. Recycles numbers — N is the smallest positive integer
 * not already taken by another terminal pane in the SAME array (labels are
 * scoped per-desk). Returns the same array reference when nothing changed
 * so callers can short-circuit.
 */
const normalizeTerminalLabels = (panes: PaneState[]): PaneState[] => {
  const used = new Set<number>();
  for (const p of panes) {
    if (p.paneView === 'terminal' && p.label) {
      const m = TERMINAL_LABEL_RE.exec(p.label);
      if (m) used.add(parseInt(m[1], 10));
    }
  }

  const nextFree = (): number => {
    let n = 1;
    while (used.has(n)) n += 1;
    used.add(n);
    return n;
  };

  let changed = false;
  const next = panes.map(pane => {
    if (pane.paneView === 'terminal') {
      if (!pane.label) {
        changed = true;
        return { ...pane, label: `Terminal ${nextFree()}` };
      }
      return pane;
    }
    if (pane.label) {
      changed = true;
      const { label: _label, ...rest } = pane;
      return rest;
    }
    return pane;
  });
  return changed ? next : panes;
};

const createPane = (paneView: PaneView = 'terminal', projectId: string | null = null): PaneState => ({
  id: generateId(),
  projectId,
  sessionId: paneView === 'terminal' ? newCliSessionId() : null,
  paneView,
});

const createDeskWithPane = (
  slug: string,
  name: string,
  defaultProjectId: string | null = null,
  spaceId: string | null = null,
): DeskState => {
  const pane = createPane('terminal', defaultProjectId);
  return {
    id: generateDeskId(),
    spaceId,
    slug,
    name,
    defaultProjectId,
    panes: normalizeTerminalLabels([pane]),
    activePaneId: pane.id,
  };
};

const createDefaultState = (): PaneStoreSnapshot => {
  const desk = createDeskWithPane('desk-1', 'Desk 1');
  return { desks: [desk], activeDeskId: desk.id, activeSpaceId: null, sessionViews: {} };
};

// ── Persistence ─────────────────────────────────────────────────────
const parsePane = (entry: unknown): PaneState | null => {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string') return null;
  return {
    id: e.id,
    projectId: typeof e.projectId === 'string' ? e.projectId : null,
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
    paneView: isPaneView(e.paneView) ? e.paneView : 'terminal',
    label: typeof e.label === 'string' ? e.label : undefined,
    title: typeof e.title === 'string' && e.title.trim() ? e.title : undefined,
    pinned: e.pinned === true ? true : undefined,
    noteId: typeof e.noteId === 'string' && e.noteId ? e.noteId : undefined,
    taskId: typeof e.taskId === 'string' && e.taskId ? e.taskId : undefined,
    provider: e.provider === 'claude' || e.provider === 'codex' ? e.provider : undefined,
  };
};

// A session's remembered view wins over the persisted pane view; panes
// without a session (brain panes) keep whatever was persisted. Resolved on
// load so restored panes follow the rule too, not only freshly-opened ones.
const resolvePaneViews = (
  panes: PaneState[],
  sessionViews: Record<string, PaneView>,
): PaneState[] =>
  panes.map((p) => ({
    ...p,
    paneView: p.sessionId ? (sessionViews[p.sessionId] ?? p.paneView) : p.paneView,
  }));

const finalisePanes = (
  panes: PaneState[],
  sessionViews: Record<string, PaneView>,
): PaneState[] => normalizeTerminalLabels(resolvePaneViews(panes, sessionViews));

const resolveActivePaneId = (panes: PaneState[], wanted: unknown): string => {
  const w = typeof wanted === 'string' ? wanted : '';
  return panes.some(p => p.id === w) ? w : panes[0].id;
};

const parseDesk = (
  entry: unknown,
  sessionViews: Record<string, PaneView>,
): DeskState | null => {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !Array.isArray(e.panes)) return null;
  const panes = finalisePanes(
    e.panes.map(parsePane).filter((p): p is PaneState => p !== null),
    sessionViews,
  );
  if (panes.length === 0) return null;
  const slug = typeof e.slug === 'string' && e.slug ? e.slug : 'desk';
  // Default names persisted before the "Desk" rename migrate on load: "Space N"
  // and the old first desk ("Dev", slug `dev`). Anything the user typed
  // stays as it is; the slug is kept, it is the desk's stable identifier.
  const rawName = typeof e.name === 'string' && e.name ? e.name : slug;
  const name = slug === 'dev' && rawName === 'Dev'
    ? 'Desk 1'
    : rawName.replace(/^Space (\d+)$/, 'Desk $1');
  return {
    id: e.id,
    spaceId: typeof e.spaceId === 'string' && e.spaceId ? e.spaceId : null,
    slug,
    name,
    defaultProjectId: typeof e.defaultProjectId === 'string' ? e.defaultProjectId : null,
    panes,
    activePaneId: resolveActivePaneId(panes, e.activePaneId),
  };
};

const parseSessionViews = (raw: unknown): Record<string, PaneView> => {
  const sessionViews: Record<string, PaneView> = {};
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof key === 'string' && isPaneView(value) && value !== 'note') sessionViews[key] = value;
    }
  }
  return sessionViews;
};

let loadedLegacyKeys = false;

const loadPersisted = (): PaneStoreSnapshot | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const sessionViews = parseSessionViews(obj.sessionViews);

    // Layouts persisted before 0.17.4 call desks `spaces` / `activeSpaceId`;
    // they load as they are and are written back under the new keys.
    loadedLegacyKeys = obj.desks === undefined && obj.spaces !== undefined;
    const rawDesks = obj.desks ?? obj.spaces;
    const rawActive = obj.activeDeskId ?? obj.activeSpaceId;
    if (!Array.isArray(rawDesks)) return null;
    const desks = rawDesks
      .map(s => parseDesk(s, sessionViews))
      .filter((s): s is DeskState => s !== null);
    if (desks.length === 0) return null;
    const wanted = typeof rawActive === 'string' ? rawActive : '';
    const activeDesk = desks.find(s => s.id === wanted) ?? desks[0];
    return { desks, activeDeskId: activeDesk.id, activeSpaceId: activeDesk.spaceId, sessionViews };
  } catch {
    return null;
  }
};

const persist = (snap: PaneStoreSnapshot): void => {
  try {
    if (snap.desks.length === 0) {
      // Don't persist a corrupt empty layout; let next load fall back to default.
      localStorage.removeItem(STORAGE_KEY);
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {
    // Storage unavailable / quota exceeded — non-fatal.
  }
};

// ── Module state ─────────────────────────────────────────────────────
let snapshot: PaneStoreSnapshot = loadPersisted() ?? createDefaultState();
// Persist the freshly created default layout right away: the pane id and the
// pre-minted session id must survive a reload even before the user touches
// anything, otherwise the first reload would spawn a second session instead
// of reattaching to the running one.
// Also rewrite a layout loaded from the pre-0.17.4 keys under the new ones.
if (!localStorage.getItem(STORAGE_KEY) || loadedLegacyKeys) persist(snapshot);

const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

const getSnapshot = (): PaneStoreSnapshot => snapshot;

const setSnapshot = (next: PaneStoreSnapshot): void => {
  // Normalise terminal labels per-desk; preserve references when unchanged
  // so consumers subscribed to a single desk don't re-render needlessly.
  let desksChanged = false;
  const desks = next.desks.map(desk => {
    const panes = normalizeTerminalLabels(desk.panes);
    if (panes === desk.panes) return desk;
    desksChanged = true;
    return { ...desk, panes };
  });
  snapshot = desksChanged ? { ...next, desks } : next;
  const active = snapshot.desks.find(s => s.id === snapshot.activeDeskId);
  if (active) lastActiveDesk.set(active.spaceId, active);
  persist(snapshot);
  for (const listener of listeners) listener();
};

// ── Internal helpers ─────────────────────────────────────────────────
const findPaneLocation = (
  paneId: string,
): { desk: DeskState; pane: PaneState } | null => {
  for (const desk of snapshot.desks) {
    const pane = desk.panes.find(p => p.id === paneId);
    if (pane) return { desk, pane };
  }
  return null;
};

/**
 * Apply `fn` to the pane with `paneId` wherever it lives. `fn` returns the
 * next pane, or the same reference / null to signal "unchanged". Returns
 * the (possibly new) desks array plus whether anything changed.
 */
const mapPaneInDesks = (
  paneId: string,
  fn: (pane: PaneState, desk: DeskState) => PaneState | null,
): { desks: DeskState[]; changed: boolean } => {
  let changed = false;
  const desks = snapshot.desks.map(desk => {
    let deskChanged = false;
    const panes = desk.panes.map(pane => {
      if (pane.id !== paneId) return pane;
      const res = fn(pane, desk);
      if (res === null || res === pane) return pane;
      deskChanged = true;
      return res;
    });
    if (!deskChanged) return desk;
    changed = true;
    return { ...desk, panes };
  });
  return { desks, changed };
};

const uniqueSlug = (base: string): string => {
  let slug = base;
  let n = 2;
  while (snapshot.desks.some(s => s.slug === slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  return slug;
};

// ── Imperative API: desks ───────────────────────────────────────────
export function getDesks(): DeskState[] {
  return snapshot.desks;
}

export function getActiveDesk(): DeskState {
  return snapshot.desks.find(s => s.id === snapshot.activeDeskId)
    ?? snapshot.desks.find(s => s.spaceId === snapshot.activeSpaceId)
    ?? snapshot.desks[0];
}

export function getActiveSpaceId(): string | null {
  return snapshot.activeSpaceId;
}

/** The desks of one space (null = main). */
export function getSpaceDesks(spaceId: string | null): DeskState[] {
  return snapshot.desks.filter(s => s.spaceId === spaceId);
}

/** The desk a pane sits on. */
export function getDeskOfPane(paneId: string): DeskState | undefined {
  return findPaneLocation(paneId)?.desk;
}

/**
 * Show a space: its last active desk, else its first, else a fresh "Desk 1"
 * made for it. Desks of other spaces stay mounted, just hidden.
 */
export function activateSpace(spaceId: string | null): void {
  if (snapshot.activeSpaceId === spaceId && getActiveDesk().spaceId === spaceId) return;
  const existing = lastActiveDesk.get(spaceId) ?? getSpaceDesks(spaceId)[0];
  if (existing) {
    setSnapshot({ ...snapshot, activeDeskId: existing.id, activeSpaceId: spaceId });
    return;
  }
  const desk = createDeskWithPane(uniqueSlug('desk-1'), 'Desk 1', null, spaceId);
  setSnapshot({ ...snapshot, desks: [...snapshot.desks, desk], activeDeskId: desk.id, activeSpaceId: spaceId });
}

// Per space, the desk that was active when the user left it (not persisted:
// after a reload the first desk of a space is as good as any). Seeded with the
// loaded layout's active desk so the first switch away and back returns to it.
const lastActiveDesk = new Map<string | null, DeskState>();
{
  const loadedActive = snapshot.desks.find(s => s.id === snapshot.activeDeskId);
  if (loadedActive) lastActiveDesk.set(loadedActive.spaceId, loadedActive);
}

export function getActiveDeskId(): string {
  return getActiveDesk().id;
}

export function getDeskBySlug(slug: string): DeskState | undefined {
  return snapshot.desks.find(s => s.slug === slug);
}

export function createDesk(opts: {
  name: string;
  slug?: string;
  defaultProjectId?: string | null;
  /** The space the desk belongs to (null = main); default: the space the cockpit shows. */
  spaceId?: string | null;
}): string {
  const slug = uniqueSlug(slugify(opts.slug ?? opts.name));
  const spaceId = opts.spaceId === undefined ? snapshot.activeSpaceId : opts.spaceId;
  const desk = createDeskWithPane(slug, opts.name, opts.defaultProjectId ?? null, spaceId);
  // Creating a desk is an explicit user action → focus it (and its space).
  setSnapshot({ ...snapshot, desks: [...snapshot.desks, desk], activeDeskId: desk.id, activeSpaceId: spaceId });
  return desk.id;
}

/**
 * Return the id of the desk with `slug`, creating it (WITHOUT stealing
 * focus) if absent. Used by task runs so a `task-<title>` desk
 * is there even on a window that hasn't created it yet.
 */
export function ensureDeskBySlug(
  slug: string,
  opts: { name?: string; defaultProjectId?: string | null } = {},
): string {
  const normalized = slugify(slug);
  const existing = snapshot.desks.find(s => s.slug === normalized);
  if (existing) return existing.id;
  const desk = createDeskWithPane(
    normalized,
    opts.name ?? normalized,
    opts.defaultProjectId ?? null,
    snapshot.activeSpaceId,
  );
  // No activeDeskId change — background spawns shouldn't yank the user
  // out of their current desk.
  setSnapshot({ ...snapshot, desks: [...snapshot.desks, desk] });
  return desk.id;
}

export function renameDesk(id: string, name: string): void {
  let changed = false;
  const desks = snapshot.desks.map(s => {
    if (s.id !== id || s.name === name) return s;
    changed = true;
    return { ...s, name };
  });
  if (!changed) return;
  setSnapshot({ ...snapshot, desks });
}

export function removeDesk(id: string): void {
  const desk = snapshot.desks.find(s => s.id === id);
  if (!desk) return;
  // A space keeps at least one desk.
  const siblings = getSpaceDesks(desk.spaceId);
  if (siblings.length <= 1) return;
  const idx = siblings.findIndex(s => s.id === id);
  const desks = snapshot.desks.filter(s => s.id !== id);
  let activeDeskId = snapshot.activeDeskId;
  if (activeDeskId === id) {
    const remaining = siblings.filter(s => s.id !== id);
    activeDeskId = remaining[Math.max(0, idx - 1)]?.id ?? remaining[0].id;
  }
  lastActiveDesk.delete(desk.spaceId);
  setSnapshot({ ...snapshot, desks, activeDeskId });
}

/**
 * Move desk `id` next to desk `targetId`, before or after it. Desks belong to
 * a space, so a move only happens within one space; the bar order (and with
 * it the ⌘1–9 shortcuts) follows the order of the desks array.
 */
export function moveDesk(id: string, targetId: string, place: 'before' | 'after'): void {
  if (id === targetId) return;
  const desk = snapshot.desks.find(s => s.id === id);
  const target = snapshot.desks.find(s => s.id === targetId);
  if (!desk || !target || desk.spaceId !== target.spaceId) return;
  const desks = snapshot.desks.filter(s => s.id !== id);
  const at = desks.indexOf(target) + (place === 'after' ? 1 : 0);
  desks.splice(at, 0, desk);
  if (desks.every((s, i) => s === snapshot.desks[i])) return;
  setSnapshot({ ...snapshot, desks });
}

export function activateDesk(id: string): void {
  if (snapshot.activeDeskId === id) return;
  const desk = snapshot.desks.find(s => s.id === id);
  if (!desk) return;
  // Activating a desk of another space switches the space with it.
  setSnapshot({ ...snapshot, activeDeskId: id, activeSpaceId: desk.spaceId });
}

// ── Imperative API: panes ────────────────────────────────────────────
export function getActivePane(): PaneState | undefined {
  const desk = getActiveDesk();
  return desk.panes.find(p => p.id === desk.activePaneId);
}

export function getPane(id: string): PaneState | undefined {
  return findPaneLocation(id)?.pane;
}

/** All panes across every desk (flattened) — for global dedupe/cleanup. */
export function getPanes(): PaneState[] {
  return snapshot.desks.flatMap(s => s.panes);
}

/** Panes of the currently active desk only — what the grid renders. */
export function getActiveDeskPanes(): PaneState[] {
  return getActiveDesk().panes;
}

export function getActivePaneId(): string {
  return getActiveDesk().activePaneId;
}

/** Add a pane to a specific desk (no focus change to the desk). */
export function addPaneToDesk(
  deskId: string,
  init: Partial<Omit<PaneState, 'id'>> = {},
): string {
  const desk = snapshot.desks.find(s => s.id === deskId) ?? getActiveDesk();
  const newPane: PaneState = {
    ...createPane(init.paneView ?? 'terminal'),
    ...init,
    id: generateId(),
  };
  // Inherit the desk's default project when the caller didn't specify one.
  if (init.projectId === undefined && desk.defaultProjectId) {
    newPane.projectId = desk.defaultProjectId;
  }
  // If a session was provided and it has a remembered view, honor it
  // (unless the caller explicitly overrode paneView in init).
  if (init.paneView === undefined && newPane.sessionId && snapshot.sessionViews[newPane.sessionId]) {
    newPane.paneView = snapshot.sessionViews[newPane.sessionId];
  }
  const desks = snapshot.desks.map(s =>
    s.id === desk.id
      ? { ...s, panes: [...s.panes, newPane], activePaneId: newPane.id }
      : s,
  );
  setSnapshot({ ...snapshot, desks });
  return newPane.id;
}

/** Add a pane to the active desk and focus it. */
export function addPane(init: Partial<Omit<PaneState, 'id'>> = {}): string {
  return addPaneToDesk(snapshot.activeDeskId, init);
}

/**
 * Add a pane directly to the right of `paneId` in its desk and focus it
 * (the pane header's "+"). Falls back to appending to
 * the active desk when the pane can't be found.
 */
export function addPaneNextTo(paneId: string, init: Partial<Omit<PaneState, 'id'>> = {}): string {
  const loc = findPaneLocation(paneId);
  if (!loc) return addPane(init);
  const { desk, pane } = loc;
  const newPane: PaneState = {
    ...createPane(init.paneView ?? 'terminal'),
    ...init,
    id: generateId(),
  };
  // Project: the source pane's, else the desk's default, else whatever project
  // the desk's other panes work in — a fresh terminal must never land on the
  // "Choose Your Project" screen next to a project that is right there.
  if (init.projectId === undefined) {
    newPane.projectId =
      pane.projectId ??
      desk.defaultProjectId ??
      desk.panes.find(p => p.projectId)?.projectId ??
      null;
  }
  const idx = desk.panes.findIndex(p => p.id === pane.id);
  const panes = [...desk.panes.slice(0, idx + 1), newPane, ...desk.panes.slice(idx + 1)];
  const desks = snapshot.desks.map(s =>
    s.id === desk.id ? { ...s, panes, activePaneId: newPane.id } : s,
  );
  setSnapshot({ ...snapshot, desks });
  return newPane.id;
}

export function removePane(id: string): void {
  const loc = findPaneLocation(id);
  if (!loc) return;
  const { desk } = loc;
  // Pinned panes are never removed. The last pane of a desk is not removed
  // either — it goes back to the empty "Choose Your Project" state.
  if (loc.pane.pinned) return;
  if (desk.panes.length <= 1) {
    clearPane(id);
    return;
  }
  const idx = desk.panes.findIndex(p => p.id === id);
  const nextPanes = desk.panes.filter(p => p.id !== id);
  let activePaneId = desk.activePaneId;
  if (desk.activePaneId === id) {
    // Activate the previous sibling, or the new first pane.
    const fallbackIdx = Math.max(0, idx - 1);
    activePaneId = nextPanes[fallbackIdx]?.id ?? nextPanes[0].id;
  }
  const desks = snapshot.desks.map(s =>
    s.id === desk.id ? { ...s, panes: nextPanes, activePaneId } : s,
  );
  setSnapshot({ ...snapshot, desks });
}

/** Whether `movePaneToDesk(paneId, deskId)` would move anything. */
export function canMovePaneToDesk(paneId: string, deskId: string): boolean {
  const loc = findPaneLocation(paneId);
  const target = snapshot.desks.find(s => s.id === deskId);
  return Boolean(loc && target && !loc.pane.pinned && loc.desk.id !== target.id && loc.desk.spaceId === target.spaceId);
}

/**
 * Move a pane to the end of another desk of the same space and show it there.
 * Only the view moves: its session keeps running on the host, and the
 * terminal reattaches to it on the target desk. Pinned panes stay on their
 * desk. On a desk that only shows the empty "Choose Your Project" pane, the
 * moved pane takes its place; a desk the move leaves empty gets a fresh empty
 * pane, the state closing its last pane leads to.
 */
export function movePaneToDesk(paneId: string, deskId: string): void {
  if (!canMovePaneToDesk(paneId, deskId)) return;
  const { desk: source, pane } = findPaneLocation(paneId)!;
  const idx = source.panes.findIndex(p => p.id === paneId);
  const rest = source.panes.filter(p => p.id !== paneId);
  const sourcePanes = rest.length > 0 ? rest : [createPane('terminal')];
  // Like removePane: the moved pane's previous sibling takes over as active.
  const sourceActive = source.activePaneId === paneId
    ? (sourcePanes[Math.max(0, idx - 1)] ?? sourcePanes[0]).id
    : source.activePaneId;
  const desks = snapshot.desks.map(s => {
    if (s.id === source.id) return { ...s, panes: sourcePanes, activePaneId: sourceActive };
    if (s.id === deskId) {
      const keep = s.panes.length === 1 && isEmptyPane(s.panes[0]) ? [] : s.panes;
      return { ...s, panes: [...keep, pane], activePaneId: pane.id };
    }
    return s;
  });
  setSnapshot({ ...snapshot, desks, activeDeskId: deskId });
}

/**
 * Reset a pane to the empty state: no project, a fresh (unused) session id,
 * no label. Closing or deleting the session of a desk's last pane lands here.
 */
export function clearPane(id: string): void {
  const { desks, changed } = mapPaneInDesks(id, (pane) => ({
    ...pane,
    projectId: null,
    sessionId: newCliSessionId(),
    paneView: 'terminal',
    label: undefined,
    title: undefined,
    provider: undefined,
  }));
  if (changed) setSnapshot({ ...snapshot, desks });
}

export function activatePane(id: string): void {
  const loc = findPaneLocation(id);
  if (!loc) return;
  const { desk, pane } = loc;
  if (snapshot.activeDeskId === desk.id && desk.activePaneId === pane.id) return;
  const desks = desk.activePaneId === pane.id
    ? snapshot.desks
    : snapshot.desks.map(s => (s.id === desk.id ? { ...s, activePaneId: pane.id } : s));
  setSnapshot({ ...snapshot, desks, activeDeskId: desk.id });
}

export function updatePane(id: string, patch: Partial<Omit<PaneState, 'id'>>): void {
  const { desks, changed } = mapPaneInDesks(id, (pane) => {
    const next: PaneState = { ...pane, ...patch };
    // Switching session within a pane: snap to that session's remembered
    // view mode. Sessions without a stored preference open in Terminal
    // view by default (an explicit per-session choice still wins).
    if ('sessionId' in patch && next.sessionId !== pane.sessionId && next.sessionId) {
      next.paneView = snapshot.sessionViews[next.sessionId] ?? 'terminal';
    }
    // The provider choice belongs to the session it was made for.
    if (next.sessionId !== pane.sessionId && !('provider' in patch)) next.provider = undefined;
    if (
      next.projectId === pane.projectId &&
      next.sessionId === pane.sessionId &&
      next.paneView === pane.paneView &&
      next.pinned === pane.pinned &&
      next.label === pane.label &&
      next.title === pane.title &&
      next.noteId === pane.noteId &&
      next.provider === pane.provider
    ) {
      return pane;
    }
    return next;
  });
  if (!changed) return;
  setSnapshot({ ...snapshot, desks });
}

/**
 * Set (or clear) a pane's user-chosen title. Empty/whitespace clears the
 * override so the pane falls back to its auto label.
 */
export function renamePane(id: string, title: string): void {
  const trimmed = title.trim();
  updatePane(id, { title: trimmed || undefined });
}

/**
 * Switch a pane's body between Terminal and Brain. Mutually exclusive —
 * selecting one deselects the other.
 *
 * If the pane has a session attached, the choice is also remembered
 * per-session so the pane snaps back to the same view next time that
 * session is loaded (in this or any other pane).
 */
export function setPaneView(paneId: string, view: PaneView): void {
  const loc = findPaneLocation(paneId);
  if (!loc || loc.pane.paneView === view) return;
  let sessionViews = snapshot.sessionViews;
  // A note is not a view of the session, so it is never remembered for it.
  if (loc.pane.sessionId && view !== 'note') {
    sessionViews = { ...sessionViews, [loc.pane.sessionId]: view };
  }
  // A pane opened as a note or brain view has no session yet; the terminal
  // only starts with one, so switching to it mints the id a new pane would get.
  const sessionId = view === 'terminal' && !loc.pane.sessionId ? newCliSessionId() : loc.pane.sessionId;
  const { desks } = mapPaneInDesks(paneId, (pane) => ({ ...pane, paneView: view, sessionId }));
  setSnapshot({ ...snapshot, desks, sessionViews });
}

// ── Opening things (decision cockpit-pane-model) ───────────────────────
// A pane is an area for one project holding at most one item per surface
// (terminal → session, note → note, brain → the project's brain view) and
// showing one of them. Each item lives in at most one pane across all desks.
// Every user action that opens or focuses something goes through openInPane;
// background worker spawns (addWorkerPane) deliberately do not.

export type OpenTarget =
  /** An existing session; or a fresh one when sessionId is left out — with `provider`, or the cockpit's default. */
  | { surface: 'terminal'; projectId: string | null; sessionId?: string; provider?: LLMProvider }
  | { surface: 'note'; projectId: string | null; noteId: string }
  | { surface: 'brain'; projectId: string | null };

/**
 * Whether a pane is the empty "Choose Your Project" pane. Needs the known
 * projects (a stale projectId or a never-spawned session id doesn't count), so
 * AppContent registers the test; without it only a pane with no project counts.
 */
let isEmptyPaneTest: (pane: PaneState) => boolean = (pane) => pane.paneView === 'terminal' && !pane.projectId;

export function setEmptyPaneTest(test: (pane: PaneState) => boolean): void {
  isEmptyPaneTest = test;
}

export function isEmptyPane(pane: PaneState): boolean {
  return isEmptyPaneTest(pane);
}

/** The pane that already holds the target's item, on any desk. */
function findPaneHolding(target: OpenTarget): PaneState | undefined {
  const panes = snapshot.desks.flatMap(s => s.panes);
  switch (target.surface) {
    case 'terminal':
      return target.sessionId ? panes.find(p => p.sessionId === target.sessionId) : undefined;
    case 'note':
      return panes.find(p => p.noteId === target.noteId);
    case 'brain':
      // The brain view is not a unique item: only a pane showing it right now.
      return panes.find(p => p.paneView === 'brain' && p.projectId === target.projectId);
  }
}

/**
 * Open `target` where the user will see it, and return the pane id:
 * 1. a pane already holds it → leave the Brain tab, switch to its desk, focus
 *    it and show that surface;
 * 2. else the active pane is empty → it goes there;
 * 3. else → a new pane right of the active one, on the visible desk.
 * Never into a free slot of a busy pane (a running terminal stays visible).
 */
export function openInPane(target: OpenTarget): string {
  setTopView('desks');
  const existing = findPaneHolding(target);
  if (existing) {
    activatePane(existing.id);
    if (existing.paneView !== target.surface) {
      const { desks } = mapPaneInDesks(existing.id, (pane) => ({ ...pane, paneView: target.surface }));
      setSnapshot({ ...snapshot, desks });
    }
    return existing.id;
  }

  const items: Partial<PaneState> =
    target.surface === 'terminal'
      ? { sessionId: target.sessionId ?? newCliSessionId(), provider: target.sessionId ? undefined : target.provider }
      : target.surface === 'note'
        ? { noteId: target.noteId }
        : {};
  const fields: Partial<Omit<PaneState, 'id'>> = { projectId: target.projectId, paneView: target.surface, ...items };

  const active = getActivePane();
  if (active && isEmptyPane(active)) {
    // Set directly (not updatePane): the target's surface wins over a
    // session's remembered view, and a new title/label starts clean.
    const { desks } = mapPaneInDesks(active.id, (pane) => ({ ...pane, ...fields, title: undefined }));
    setSnapshot({ ...snapshot, desks });
    return active.id;
  }
  return addPaneNextTo(getActiveDesk().activePaneId, {
    ...fields,
    ...(target.surface === 'terminal' ? {} : { sessionId: null }),
  });
}

/** Show a note (openInPane). */
export function openNote(noteId: string, projectId: string | null): string {
  return openInPane({ surface: 'note', noteId, projectId });
}

/**
 * A note was archived: every pane that showed it drops the note and falls back
 * to the note list (what NotePane does for its own pane). Panes stay open — one
 * may also hold a session.
 */
export function forgetNoteInPanes(noteId: string): void {
  let changed = false;
  const desks = snapshot.desks.map(desk => {
    if (!desk.panes.some(p => p.noteId === noteId)) return desk;
    changed = true;
    return { ...desk, panes: desk.panes.map(p => (p.noteId === noteId ? { ...p, noteId: undefined } : p)) };
  });
  if (changed) setSnapshot({ ...snapshot, desks });
}

// ── Cross-tab sync ────────────────────────────────────────────────────
// The `storage` event fires in OTHER browsing contexts when the source
// of truth in localStorage changes — i.e. when a second window mutates the
// layout, this window's paneStore needs to refresh from disk. We re-parse
// the persisted snapshot rather than diffing — cheap at realistic layout
// sizes and avoids re-implementing the schema validator.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const fresh = loadPersisted();
    if (!fresh) return;
    snapshot = fresh;
    for (const listener of listeners) listener();
  });
}

// ── Hook API ─────────────────────────────────────────────────────────
/** Subscribe to the full snapshot — re-renders on any mutation. */
export function usePaneStore(): PaneStoreSnapshot {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Subscribe to the list of desks (for the desk tab bar). */
export function useDesks(): DeskState[] {
  return useSyncExternalStore(subscribe, getDesks);
}

/** Subscribe to the active desk (its panes + active pane id). */
export function useActiveDesk(): DeskState {
  return useSyncExternalStore(subscribe, getActiveDesk);
}

/** Subscribe to the active desk id only. */
export function useActiveDeskId(): string {
  return useSyncExternalStore(subscribe, getActiveDeskId);
}

/** Subscribe to the active space (null = main). */
export function useActiveSpaceId(): string | null {
  return useSyncExternalStore(subscribe, getActiveSpaceId);
}

const getActiveSpaceDesks = (): DeskState[] => getSpaceDesks(snapshot.activeSpaceId);
let spaceDesksCache: { desks: DeskState[]; spaceId: string | null; result: DeskState[] } | null = null;
// useSyncExternalStore needs a stable result for an unchanged input.
const getActiveSpaceDesksStable = (): DeskState[] => {
  if (spaceDesksCache && spaceDesksCache.desks === snapshot.desks && spaceDesksCache.spaceId === snapshot.activeSpaceId) {
    return spaceDesksCache.result;
  }
  const result = getActiveSpaceDesks();
  spaceDesksCache = { desks: snapshot.desks, spaceId: snapshot.activeSpaceId, result };
  return result;
};

/** Subscribe to the desks of the active space (the desk tab bar). */
export function useSpaceDesks(): DeskState[] {
  return useSyncExternalStore(subscribe, getActiveSpaceDesksStable);
}

/** Subscribe to a single pane's state only. */
export function usePane(id: string): PaneState | undefined {
  const getPaneSnapshot = useCallback(() => getPane(id), [id]);
  return useSyncExternalStore(subscribe, getPaneSnapshot);
}

/** Subscribe to the active pane only. */
export function useActivePane(): PaneState | undefined {
  return useSyncExternalStore(subscribe, getActivePane);
}

/** Subscribe to the active pane id only. */
export function useActivePaneId(): string {
  return useSyncExternalStore(subscribe, getActivePaneId);
}

// ── Pending shell command ────────────────────────────────────────────
/**
 * The pane a first-run session may take the place of: the active desk's only
 * pane, while it is still empty ("Choose Your Project"). Read when the request
 * arrives — loading its project can auto-select it into that pane.
 */
export function findEmptyDeskPane(): string | null {
  const desk = snapshot.desks.find(s => s.id === snapshot.activeDeskId) ?? snapshot.desks[0];
  const only = desk?.panes.length === 1 ? desk.panes[0] : null;
  return only && isEmptyPane(only) ? only.id : null;
}

/**
 * A worker session another session asked for (skill spawn-session): a
 * terminal pane on the requester's desk, right of the requester's pane,
 * starting with `prompt` as its first message. Focus stays where it is — the
 * user may be typing in the requester. Without a known requester it lands on
 * the active desk. A task run (v0.17) names its desk (`deskId`) and its task.
 *
 * `replacePaneId` (first run: the sign-in and getting-started sessions the
 * host opens, see findEmptyDeskPane): that pane — still the only one on its
 * desk — is swapped for the new pane, which becomes active.
 */
export function addWorkerPane(opts: {
  fromSessionId: string | null;
  projectId: string;
  prompt: string;
  title: string | null;
  deskId?: string;
  /** The space the worker runs in (null = main); picks a desk when no requester pane is known. */
  spaceId?: string | null;
  taskId?: string;
  /** The agent CLI the worker runs with; unset → the cockpit's default. */
  provider?: LLMProvider;
  replacePaneId?: string | null;
}): string {
  const from = opts.fromSessionId
    ? snapshot.desks
        .flatMap(desk => desk.panes.map(pane => ({ desk, pane })))
        .find(({ pane }) => pane.sessionId === opts.fromSessionId)
    : undefined;
  const newPane: PaneState = {
    ...createPane('terminal', opts.projectId),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
  const replaced = opts.replacePaneId
    ? snapshot.desks.find(s => s.panes.length === 1 && s.panes[0].id === opts.replacePaneId)
    : undefined;
  // The worker runs in its space: the requester's desk, else a desk of the
  // named space (made if the window has none — the worker is its only pane),
  // else the active desk. Always the live desk: lastActiveDesk holds a
  // snapshot that may miss panes added since.
  let desks = snapshot.desks;
  const live = (candidate: DeskState | undefined) => (candidate ? snapshot.desks.find(s => s.id === candidate.id) : undefined);
  let desk =
    snapshot.desks.find(s => s.id === opts.deskId) ??
    live(from?.desk) ??
    (opts.spaceId !== undefined && getActiveDesk().spaceId !== opts.spaceId
      ? (live(lastActiveDesk.get(opts.spaceId)) ?? getSpaceDesks(opts.spaceId)[0])
      : undefined);
  if (!desk && !replaced && opts.spaceId !== undefined && getActiveDesk().spaceId !== opts.spaceId) {
    desk = { ...createDeskWithPane(uniqueSlug('desk-1'), 'Desk 1', null, opts.spaceId), panes: [], activePaneId: newPane.id };
    desks = [...snapshot.desks, desk];
  }
  desk ??= getActiveDesk();
  if (replaced && !hasPendingShellCommand(opts.replacePaneId!)) {
    // Queue the prompt first: the pane is on screen, so it mounts (and reads
    // its first message) as soon as the snapshot changes.
    enqueuePendingShellCommand(newPane.id, opts.prompt);
    setSnapshot({
      ...snapshot,
      activeDeskId: replaced.id,
      activeSpaceId: replaced.spaceId,
      desks: snapshot.desks.map(s => (s.id === replaced.id ? { ...s, panes: [newPane], activePaneId: newPane.id } : s)),
    });
    setTopView('desks');
    return newPane.id;
  }
  const target = desk;
  const idx = from && from.desk.id === target.id ? target.panes.findIndex(p => p.id === from.pane.id) : target.panes.length - 1;
  const panes = [...target.panes.slice(0, idx + 1), newPane, ...target.panes.slice(idx + 1)];
  setSnapshot({ ...snapshot, desks: desks.map(s => (s.id === target.id ? { ...s, panes } : s)) });
  enqueuePendingShellCommand(newPane.id, opts.prompt);
  return newPane.id;
}

// Per-pane first-message queue for worker panes (skill spawn-session): the
// prompt waits here until the pane's terminal mounts and MainContent passes it
// as `initialCommand` to StandaloneShell. Persisted (0.15.1) so a worker whose
// desk wasn't shown yet survives a reload — the spawn request is already
// claimed, so a lost prompt would open a blank session. Read-and-clear, so it
// fires once; entries of panes that no longer exist are dropped on load.
const PENDING_KEY = 'cockpit-pending-shell-commands';

const loadPending = (): Map<string, string> => {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '{}') as Record<string, unknown>;
    const live = new Set(snapshot.desks.flatMap(sp => sp.panes.map(p => p.id)));
    return new Map(Object.entries(raw).filter((e): e is [string, string] => typeof e[1] === 'string' && live.has(e[0])));
  } catch {
    return new Map();
  }
};

const pendingShellCommands = loadPending();

const persistPending = (): void => {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(Object.fromEntries(pendingShellCommands))); } catch { /* non-fatal */ }
};

export function enqueuePendingShellCommand(paneId: string, command: string): void {
  pendingShellCommands.set(paneId, command);
  persistPending();
}

export function hasPendingShellCommand(paneId: string): boolean {
  return pendingShellCommands.has(paneId);
}

/** The queued first message without taking it (MainContent reads it during render). */
export function peekPendingShellCommand(paneId: string): string | null {
  return pendingShellCommands.get(paneId) ?? null;
}

export function consumePendingShellCommand(paneId: string): string | null {
  const entry = pendingShellCommands.get(paneId);
  if (entry === undefined) return null;
  pendingShellCommands.delete(paneId);
  persistPending();
  return entry;
}
