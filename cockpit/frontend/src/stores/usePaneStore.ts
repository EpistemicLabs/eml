/**
 * Multi-pane / multi-desk layout store.
 *
 * Every agent session runs in the chat; its terminal is only a hidden
 * fallback for debugging (Settings › Advanced, lib/terminal-fallback.ts), a
 * flag on a chat pane rather than a view of its own. No sub-panes / editor /
 * todos. Projects are the host's project registry (decision
 * cockpit-isolation-scope-clarified). What stays: Desks → Panes, a session id
 * per session pane, persistence with validation and cross-tab sync.
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
import type { EngramType } from '@/lib/types';
import type { LLMProvider } from '@/types/app';
import { chatProvider, type AgentProviderInfo } from '@/lib/providers';
import { useCallback, useSyncExternalStore } from 'react';
import { queueChatStart } from '@/components/chat/chat-start';
import { setTopView } from './useTopViewStore';

/**
 * Primary view mode for a pane's body. Mutually exclusive.
 *
 * Chat mode shows the pane's agent session (ChatPane); with `terminalFallback`
 * set it shows the same session in the agent's own terminal instead. Brain mode
 * renders the local brain's views (graph / timeline / list). Note mode edits
 * one `type=note` engram of the pane's project (decision cockpit-notes-pane).
 * Worktrees mode shows the project's worktrees, sessions and ports. Repository
 * mode shows a checkout's diffs, files and commits, read-only. Shell mode is
 * a terminal on this computer, the user's own shell in the home folder, not
 * tied to the project. Time mode shows the work time across projects. File mode
 * shows one file pinned from the media viewer ("Open as pane"); it is no tab of
 * the view switch, the pane holds that file alone. Labels, icons and groups of the views: lib/pane-views.ts.
 */
export type PaneView = 'chat' | 'brain' | 'note' | 'worktrees' | 'repository' | 'shell' | 'time' | 'file';

export const PANE_VIEWS: ReadonlyArray<PaneView> = ['chat', 'brain', 'note', 'worktrees', 'repository', 'shell', 'time', 'file'];

const isPaneView = (value: unknown): value is PaneView =>
  typeof value === 'string' && (PANE_VIEWS as readonly string[]).includes(value);

export interface PaneState {
  id: string;
  /** The host-registered project this pane's session runs in (cwd). */
  projectId: string | null;
  /**
   * The agent session this pane owns. Pre-minted (UUID) the moment a
   * session pane is created — Claude's CLI accepts `--session-id <uuid>`,
   * so the pane owns the id up front and the host can `--resume` it later
   * (see decision cockpit-session-resume-strategy). Brain panes carry null.
   */
  sessionId: string | null;
  paneView: PaneView;
  /**
   * Auto-assigned label for session panes ("Chat 1", "Chat 2", …) so
   * parallel sessions are distinguishable in the pane title before they have
   * a name. Only set while `paneView === 'chat'`; cleared on toggle to brain.
   * Numbers are recycled when a labelled pane closes, scoped per-desk.
   */
  label?: string;
  /**
   * The pane shows its session in the agent's own terminal (the hidden
   * terminal fallback, Settings › Advanced) instead of the chat. Only while
   * `paneView === 'chat'`; "Back to chat", another view or another session
   * clears it, and so does the switch going off.
   */
  terminalFallback?: boolean;
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
   * The file a file pane shows (absolute path), pinned from the media viewer's
   * "Open as pane". Kept with the layout, so the pane survives a reload and a restart.
   */
  filePath?: string;
  /**
   * How the brain view of this pane was left (BrainPane): lens, reach and the
   * types hidden. Kept with the layout, so the pane opens where it was after a
   * desk switch or a reload; unset → timeline, project reach, every type.
   */
  brainView?: BrainPaneView;
  /**
   * Where the repository view of this pane was left (RepositoryPane): the checkout,
   * the tab, the open file. Kept with the layout like brainView; unset → the
   * project folder's changes.
   */
  repositoryView?: RepositoryPaneView;
  /**
   * The shell this pane's Shell view runs (host pty-bridge.ts): minted when the
   * view first shows, kept so a reload reattaches to it; it ends with the pane.
   */
  shellId?: string;
  /**
   * v0.17: the brain task this pane's session advances (a task run, skill
   * task-run). Sent with the session's init so the host ledger records it.
   */
  taskId?: string;
  /**
   * The agent CLI a NEW session in this pane starts with (a host provider
   * id); unset → the cockpit's default. Sent with the session's init. The
   * host records it with the session, so it only matters on the first spawn
   * and is dropped when the pane moves on to another session.
   */
  provider?: LLMProvider;
}

export interface BrainPaneView {
  lens: 'timeline' | 'list';
  reach: 'project' | 'brain';
  /** Types switched off; a type the brain gains later shows. */
  hidden: EngramType[];
}

export interface RepositoryPaneView {
  /** The worktree's folder; unset → the project folder's checkout. */
  worktree?: string;
  tab: 'changes' | 'files' | 'commits';
  /** The file open in the Files tab. */
  file?: string;
  /** The commit open in the Commits tab. */
  commit?: string;
}

const parseRepositoryView = (raw: unknown): RepositoryPaneView | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);
  return {
    worktree: text(v.worktree),
    tab: v.tab === 'files' || v.tab === 'commits' ? v.tab : 'changes',
    file: text(v.file),
    commit: text(v.commit),
  };
};

const parseBrainView = (raw: unknown): BrainPaneView | undefined => {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  return {
    lens: v.lens === 'list' ? 'list' : 'timeline',
    reach: v.reach === 'brain' ? 'brain' : 'project',
    hidden: Array.isArray(v.hidden) ? (v.hidden.filter((t) => typeof t === 'string') as EngramType[]) : [],
  };
};

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
  /**
   * The desk's main pane: full height in a column at the left, the other panes
   * in the even grid beside it. Always the first of `panes` (setSnapshot keeps
   * it there), so lists of a desk's panes show it first. Unset → the even grid.
   */
  mainPaneId?: string;
  /** The main column's share of the desk's width; kept while main is off. Unset → the default. */
  mainWidth?: number;
}

interface PaneStoreSnapshot {
  desks: DeskState[];
  activeDeskId: string;
  /** The space of the active desk — the space the cockpit shows (null = main). */
  activeSpaceId: string | null;
}

const STORAGE_KEY = 'cockpit-pane-layout';

const generateId = (): string => `pane-${crypto.randomUUID()}`;

const generateDeskId = (): string => `desk-${crypto.randomUUID()}`;

// Every session pane mints its own session id at birth — the cockpit's id of
// the session. Claude Code adopts it (--session-id); Codex assigns its own and
// the host binds the two (session-ledger.ts, providerSessionId).
export const newCliSessionId = (): string => crypto.randomUUID();

const slugify = (input: string): string =>
  input.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join('-') || 'desk';

const SESSION_LABEL_RE = /^Chat (\d+)$/;

/**
 * Ensure every session pane has a unique `Chat N` label and no brain
 * pane carries one. Recycles numbers — N is the smallest positive integer
 * not already taken by another session pane in the SAME array (labels are
 * scoped per-desk). Returns the same array reference when nothing changed
 * so callers can short-circuit.
 */
const normalizeSessionLabels = (panes: PaneState[]): PaneState[] => {
  const used = new Set<number>();
  for (const p of panes) {
    if (p.paneView === 'chat' && p.label) {
      const m = SESSION_LABEL_RE.exec(p.label);
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
    if (pane.paneView === 'chat') {
      if (!pane.label) {
        changed = true;
        return { ...pane, label: `Chat ${nextFree()}` };
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

/**
 * Hold up the main pane's rules: it exists on the desk, and it comes first.
 * Returns the same desk when nothing changed.
 */
const normalizeMainPane = (desk: DeskState): DeskState => {
  if (!desk.mainPaneId) return desk;
  const main = desk.panes.find(p => p.id === desk.mainPaneId);
  if (!main) {
    const { mainPaneId: _mainPaneId, ...rest } = desk;
    return rest;
  }
  if (desk.panes[0] === main) return desk;
  return { ...desk, panes: [main, ...desk.panes.filter(p => p !== main)] };
};

const createPane = (paneView: PaneView = 'chat', projectId: string | null = null): PaneState => ({
  id: generateId(),
  projectId,
  sessionId: paneView === 'chat' ? newCliSessionId() : null,
  paneView,
});

const createDeskWithPane = (
  slug: string,
  name: string,
  defaultProjectId: string | null = null,
  spaceId: string | null = null,
): DeskState => {
  const pane = createPane('chat', defaultProjectId);
  return {
    id: generateDeskId(),
    spaceId,
    slug,
    name,
    defaultProjectId,
    panes: normalizeSessionLabels([pane]),
    activePaneId: pane.id,
  };
};

const createDefaultState = (): PaneStoreSnapshot => {
  const desk = createDeskWithPane('desk-1', 'Desk 1');
  return { desks: [desk], activeDeskId: desk.id, activeSpaceId: null };
};

// ── Persistence ─────────────────────────────────────────────────────
// Layouts from before chat was the only view: a pane in the old terminal view
// (or any view this version does not know) opens in the chat, and its
// "Terminal N" label becomes "Chat N". The per-session view memory
// (`sessionViews`) is no longer read and drops out with the next write.
export const parsePane = (entry: unknown): PaneState | null => {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string') return null;
  const paneView: PaneView = isPaneView(e.paneView) ? e.paneView : 'chat';
  return {
    id: e.id,
    projectId: typeof e.projectId === 'string' ? e.projectId : null,
    sessionId: typeof e.sessionId === 'string' ? e.sessionId : null,
    paneView,
    label: typeof e.label === 'string' ? e.label.replace(/^Terminal (\d+)$/, 'Chat $1') : undefined,
    terminalFallback: e.terminalFallback === true && paneView === 'chat' ? true : undefined,
    title: typeof e.title === 'string' && e.title.trim() ? e.title : undefined,
    pinned: e.pinned === true ? true : undefined,
    noteId: typeof e.noteId === 'string' && e.noteId ? e.noteId : undefined,
    filePath: typeof e.filePath === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(e.filePath) ? e.filePath : undefined,
    brainView: parseBrainView(e.brainView),
    repositoryView: parseRepositoryView(e.repositoryView),
    shellId: typeof e.shellId === 'string' && e.shellId ? e.shellId : undefined,
    taskId: typeof e.taskId === 'string' && e.taskId ? e.taskId : undefined,
    provider: e.provider === 'claude' || e.provider === 'codex' || e.provider === 'qwen' ? e.provider : undefined,
  };
};


const resolveActivePaneId = (panes: PaneState[], wanted: unknown): string => {
  const w = typeof wanted === 'string' ? wanted : '';
  return panes.some(p => p.id === w) ? w : panes[0].id;
};

// A stored share outside this range is not one a drag can produce: ignore it.
const parseMainWidth = (raw: unknown): number | undefined =>
  typeof raw === 'number' && raw > 0.05 && raw < 0.95 ? raw : undefined;

const parseDesk = (entry: unknown): DeskState | null => {
  if (!entry || typeof entry !== 'object') return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.id !== 'string' || !Array.isArray(e.panes)) return null;
  const panes = normalizeSessionLabels(e.panes.map(parsePane).filter((p): p is PaneState => p !== null));
  if (panes.length === 0) return null;
  const slug = typeof e.slug === 'string' && e.slug ? e.slug : 'desk';
  // Default names persisted before the "Desk" rename migrate on load: "Space N"
  // and the old first desk ("Dev", slug `dev`). Anything the user typed
  // stays as it is; the slug is kept, it is the desk's stable identifier.
  const rawName = typeof e.name === 'string' && e.name ? e.name : slug;
  const name = slug === 'dev' && rawName === 'Dev'
    ? 'Desk 1'
    : rawName.replace(/^Space (\d+)$/, 'Desk $1');
  return normalizeMainPane({
    id: e.id,
    spaceId: typeof e.spaceId === 'string' && e.spaceId ? e.spaceId : null,
    slug,
    name,
    defaultProjectId: typeof e.defaultProjectId === 'string' ? e.defaultProjectId : null,
    panes,
    activePaneId: resolveActivePaneId(panes, e.activePaneId),
    mainPaneId: typeof e.mainPaneId === 'string' && e.mainPaneId ? e.mainPaneId : undefined,
    mainWidth: parseMainWidth(e.mainWidth),
  });
};

let loadedLegacyKeys = false;

const loadPersisted = (): PaneStoreSnapshot | null => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;

    // Layouts persisted before 0.17.4 call desks `spaces` / `activeSpaceId`;
    // they load as they are and are written back under the new keys. A layout
    // from before chat was the only view is written back too, without its
    // session view memory.
    loadedLegacyKeys = (obj.desks === undefined && obj.spaces !== undefined) || obj.sessionViews !== undefined;
    const rawDesks = obj.desks ?? obj.spaces;
    const rawActive = obj.activeDeskId ?? obj.activeSpaceId;
    if (!Array.isArray(rawDesks)) return null;
    const desks = rawDesks
      .map(s => parseDesk(s))
      .filter((s): s is DeskState => s !== null);
    if (desks.length === 0) return null;
    const wanted = typeof rawActive === 'string' ? rawActive : '';
    const activeDesk = desks.find(s => s.id === wanted) ?? desks[0];
    return { desks, activeDeskId: activeDesk.id, activeSpaceId: activeDesk.spaceId };
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
// The first-message queue of terminal worker panes is gone: workers start in
// the chat on the host. What an older version left there is dropped.
try { localStorage.removeItem('cockpit-pending-shell-commands'); } catch { /* storage unavailable */ }

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
    const panes = normalizeSessionLabels(desk.panes);
    const normalized = normalizeMainPane(panes === desk.panes ? desk : { ...desk, panes });
    if (normalized === desk) return desk;
    desksChanged = true;
    return normalized;
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
    ...createPane(init.paneView ?? 'chat'),
    ...init,
    id: generateId(),
  };
  // Inherit the desk's default project when the caller didn't specify one.
  if (init.projectId === undefined && desk.defaultProjectId) {
    newPane.projectId = desk.defaultProjectId;
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
    ...createPane(init.paneView ?? 'chat'),
    ...init,
    id: generateId(),
  };
  // Project: the source pane's, else the desk's default, else whatever project
  // the desk's other panes work in — a fresh session must never land on the
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
  // Pinned and main panes are never removed. The last pane of a desk is not
  // removed either — it goes back to the empty "Choose Your Project" state.
  if (loc.pane.pinned || desk.mainPaneId === id) return;
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

/** Pinned and main panes: can't be closed, and stay on their desk. */
export function isPaneProtected(paneId: string): boolean {
  const loc = findPaneLocation(paneId);
  return Boolean(loc && (loc.pane.pinned || loc.desk.mainPaneId === paneId));
}

/** Make a pane its desk's main pane, or, if it is, return the desk to the even grid. */
export function toggleMainPane(paneId: string): void {
  const loc = findPaneLocation(paneId);
  if (!loc) return;
  const mainPaneId = loc.desk.mainPaneId === paneId ? undefined : paneId;
  const desks = snapshot.desks.map(s => (s.id === loc.desk.id ? { ...s, mainPaneId } : s));
  setSnapshot({ ...snapshot, desks });
}

/** Remember how wide a desk's main column is, as a share of the desk's width. */
export function setMainWidth(deskId: string, mainWidth: number): void {
  const desk = snapshot.desks.find(s => s.id === deskId);
  if (!desk || desk.mainWidth === mainWidth) return;
  const desks = snapshot.desks.map(s => (s.id === deskId ? { ...s, mainWidth } : s));
  setSnapshot({ ...snapshot, desks });
}

/** Whether `swapPanes(a, b)` would do anything: two panes of one desk, neither pinned. */
export function canSwapPanes(a: string, b: string): boolean {
  if (a === b) return false;
  const first = findPaneLocation(a);
  const second = findPaneLocation(b);
  return Boolean(first && second && first.desk.id === second.desk.id && !first.pane.pinned && !second.pane.pinned);
}

/**
 * Two panes of a desk trade places. Main is a place, not a property of the
 * pane: whatever lands in the main column is the main pane from then on.
 */
export function swapPanes(a: string, b: string): void {
  if (!canSwapPanes(a, b)) return;
  const { desk } = findPaneLocation(a)!;
  const panes = desk.panes.map((pane) => {
    if (pane.id === a) return findPaneLocation(b)!.pane;
    if (pane.id === b) return findPaneLocation(a)!.pane;
    return pane;
  });
  const mainPaneId = desk.mainPaneId === a ? b : desk.mainPaneId === b ? a : desk.mainPaneId;
  const desks = snapshot.desks.map(s => (s.id === desk.id ? { ...s, panes, mainPaneId } : s));
  setSnapshot({ ...snapshot, desks });
}

/** Whether `movePaneToDesk(paneId, deskId)` would move anything. */
export function canMovePaneToDesk(paneId: string, deskId: string): boolean {
  const loc = findPaneLocation(paneId);
  const target = snapshot.desks.find(s => s.id === deskId);
  return Boolean(loc && target && !isPaneProtected(paneId) && loc.desk.id !== target.id && loc.desk.spaceId === target.spaceId);
}

/**
 * Move a pane to the end of another desk of the same space and show it there.
 * Only the view moves: its session keeps running on the host, and the
 * terminal reattaches to it on the target desk. Pinned and main panes stay on
 * their desk. On a desk that only shows the empty "Choose Your Project" pane, the
 * moved pane takes its place; a desk the move leaves empty gets a fresh empty
 * pane, the state closing its last pane leads to.
 */
export function movePaneToDesk(paneId: string, deskId: string): void {
  if (!canMovePaneToDesk(paneId, deskId)) return;
  const { desk: source, pane } = findPaneLocation(paneId)!;
  const idx = source.panes.findIndex(p => p.id === paneId);
  const rest = source.panes.filter(p => p.id !== paneId);
  const sourcePanes = rest.length > 0 ? rest : [createPane('chat')];
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
    paneView: 'chat',
    label: undefined,
    title: undefined,
    provider: undefined,
    terminalFallback: undefined,
  }));
  if (changed) setSnapshot({ ...snapshot, desks });
}

export function activatePane(id: string): void {
  const loc = findPaneLocation(id);
  if (!loc) return;
  const { desk, pane } = loc;
  if (snapshot.activeDeskId === desk.id && desk.activePaneId === pane.id && snapshot.activeSpaceId === desk.spaceId) return;
  const desks = desk.activePaneId === pane.id
    ? snapshot.desks
    : snapshot.desks.map(s => (s.id === desk.id ? { ...s, activePaneId: pane.id } : s));
  setSnapshot({ ...snapshot, desks, activeDeskId: desk.id, activeSpaceId: desk.spaceId });
}

export function updatePane(id: string, patch: Partial<Omit<PaneState, 'id'>>): void {
  const { desks, changed } = mapPaneInDesks(id, (pane) => {
    const next: PaneState = { ...pane, ...patch };
    // Switching session within a pane: a session opens in the chat, never in
    // the terminal fallback the pane may have shown for the one before.
    if ('sessionId' in patch && next.sessionId !== pane.sessionId && next.sessionId) {
      next.paneView = 'chat';
      next.terminalFallback = undefined;
    }
    // The provider choice belongs to the session it was made for.
    if (next.sessionId !== pane.sessionId && !('provider' in patch)) next.provider = undefined;
    if (
      next.projectId === pane.projectId &&
      next.sessionId === pane.sessionId &&
      next.paneView === pane.paneView &&
      next.terminalFallback === pane.terminalFallback &&
      next.pinned === pane.pinned &&
      next.label === pane.label &&
      next.title === pane.title &&
      next.noteId === pane.noteId &&
      next.brainView === pane.brainView &&
      next.repositoryView === pane.repositoryView &&
      next.shellId === pane.shellId &&
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
 * Switch a pane's body between its views (chat, brain, note, …). Mutually
 * exclusive — selecting one deselects the other. Leaving the chat ends a
 * terminal fallback: coming back shows the chat.
 */
export function setPaneView(paneId: string, view: PaneView): void {
  const loc = findPaneLocation(paneId);
  if (!loc || loc.pane.paneView === view) return;
  // A pane opened as a note or brain view has no session yet; the chat only
  // starts with one, so switching to it mints the id a new pane would get.
  const sessionId = view === 'chat' && !loc.pane.sessionId ? newCliSessionId() : loc.pane.sessionId;
  const { desks } = mapPaneInDesks(paneId, (pane) => ({ ...pane, paneView: view, sessionId, terminalFallback: undefined }));
  setSnapshot({ ...snapshot, desks });
}

// ── The terminal fallback (lib/terminal-fallback.ts) ───────────────────
/**
 * Show the pane's session in the agent's own terminal instead of the chat.
 * Only offered while the cockpit's switch is on (Settings › Advanced); the host
 * refuses the terminal otherwise, and the pane goes back to the chat.
 */
export function openTerminalFallback(paneId: string): void {
  const { desks, changed } = mapPaneInDesks(paneId, (pane) =>
    pane.terminalFallback || !pane.sessionId ? null : { ...pane, paneView: 'chat', terminalFallback: true });
  if (changed) setSnapshot({ ...snapshot, desks });
}

/** Back to the chat ("Back to chat", or the host refused the terminal). */
export function closeTerminalFallback(paneId: string): void {
  const { desks, changed } = mapPaneInDesks(paneId, (pane) => {
    if (!pane.terminalFallback) return null;
    const { terminalFallback: _terminalFallback, ...rest } = pane;
    return rest;
  });
  if (changed) setSnapshot({ ...snapshot, desks });
}

/** The switch is off: every pane in the fallback goes back to the chat. */
export function closeAllTerminalFallbacks(): void {
  let changed = false;
  const desks = snapshot.desks.map(desk => {
    if (!desk.panes.some(p => p.terminalFallback)) return desk;
    changed = true;
    return {
      ...desk,
      panes: desk.panes.map(p => {
        if (!p.terminalFallback) return p;
        const { terminalFallback: _terminalFallback, ...rest } = p;
        return rest;
      }),
    };
  });
  if (changed) setSnapshot({ ...snapshot, desks });
}

// ── Opening things (decision cockpit-pane-model) ───────────────────────
// A pane is an area for one project holding at most one item per surface
// (session → its chat, note → note, brain / worktrees / repository → the project's view) and
// showing one of them. Each item lives in at most one pane across all desks.
// Every user action that opens or focuses something goes through openInPane;
// background worker spawns (addWorkerPane) deliberately do not.

export type OpenTarget =
  /**
   * An existing session, in its chat; or a fresh one when sessionId is left out — with `provider`, or the cockpit's default.
   * `provider` with a sessionId: a new chat a launcher minted the id for (chat-start.ts queueChatStart).
   * `terminalFallback`: a new session of an agent without a chat, in the terminal fallback (only while it is on).
   */
  | { surface: 'session'; projectId: string | null; sessionId?: string; provider?: LLMProvider; terminalFallback?: boolean }
  | { surface: 'note'; projectId: string | null; noteId: string }
  /** A file from the media viewer, pinned as a pane of its own. */
  | { surface: 'file'; projectId: string | null; filePath: string }
  | { surface: 'brain' | 'worktrees'; projectId: string | null }
  /** With `worktree`: that checkout's changes. */
  | { surface: 'repository'; projectId: string | null; worktree?: string };

/**
 * Whether a pane is the empty "Choose Your Project" pane. Needs the known
 * projects (a stale projectId or a never-spawned session id doesn't count), so
 * AppContent registers the test; without it only a pane with no project counts.
 */
let isEmptyPaneTest: (pane: PaneState) => boolean = (pane) => pane.paneView === 'chat' && !pane.projectId;

export function setEmptyPaneTest(test: (pane: PaneState) => boolean): void {
  isEmptyPaneTest = test;
}

export function isEmptyPane(pane: PaneState): boolean {
  return isEmptyPaneTest(pane);
}

// The provider a session without its own runs with (host: /api/providers); null until known.
let defaultProvider: string | null = null;

export function setDefaultProvider(provider: string | null): void {
  defaultProvider = provider;
}

// The providers as the host lists them, for what each can do; undefined until known.
let providers: AgentProviderInfo[] | undefined;

export function setProviders(list: AgentProviderInfo[] | undefined): void {
  providers = list;
}

/** The provider a new chat in this pane starts with, as its socket tells the host (lib/providers.ts chatProvider). */
export function chatProviderOfPane(paneId: string): string | null {
  return chatProvider(providers, getPane(paneId)?.provider, defaultProvider);
}


/**
 * The pane that already holds the target's item, on a desk of the active
 * space. Not on another space's desk: a pane there starts its session with
 * that space's token, and one left from before the session moved to this
 * space the host refuses.
 */
function findPaneHolding(target: OpenTarget): PaneState | undefined {
  const panes = getSpaceDesks(snapshot.activeSpaceId).flatMap(s => s.panes);
  switch (target.surface) {
    case 'session':
      return target.sessionId ? panes.find(p => p.sessionId === target.sessionId) : undefined;
    case 'note':
      return panes.find(p => p.noteId === target.noteId);
    case 'file':
      return panes.find(p => p.paneView === 'file' && p.filePath === target.filePath);
    case 'brain':
    case 'worktrees':
    case 'repository':
      // A project view is not a unique item: only a pane showing it right now.
      return panes.find(p => p.paneView === target.surface && p.projectId === target.projectId);
  }
}

/** The sessions shown in a desk's main pane, on this device. */
export function deskMainSessions(desks: DeskState[]): Set<string> {
  const ids = new Set<string>();
  for (const desk of desks) {
    const sessionId = desk.panes.find(p => p.id === desk.mainPaneId)?.sessionId;
    if (sessionId) ids.add(sessionId);
  }
  return ids;
}

/** The pane showing a session, on any desk. */
export function paneHoldingSession(sessionId: string): PaneState | undefined {
  return snapshot.desks.flatMap(s => s.panes).find(p => p.sessionId === sessionId);
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
  // A session opens in its chat; a pane that shows it in the terminal fallback keeps doing so.
  const shownView: PaneView = target.surface === 'session' ? 'chat' : target.surface;
  // A checkout named: the repository view turns to it, in a pane that shows the project's repository already too.
  const checkout: Partial<PaneState> =
    target.surface === 'repository' && target.worktree ? { repositoryView: { worktree: target.worktree, tab: 'changes' } } : {};
  if (existing) {
    activatePane(existing.id);
    if (existing.paneView !== shownView || checkout.repositoryView) {
      const { desks } = mapPaneInDesks(existing.id, (pane) => ({ ...pane, paneView: shownView, ...checkout }));
      setSnapshot({ ...snapshot, desks });
    }
    return existing.id;
  }

  const items: Partial<PaneState> =
    target.surface === 'session'
      // A known session keeps its own agent; a new one names it, also one whose id a launcher minted.
      ? { sessionId: target.sessionId ?? newCliSessionId(), provider: target.provider, terminalFallback: target.terminalFallback || undefined }
      : target.surface === 'note'
        ? { noteId: target.noteId }
        : target.surface === 'file'
          ? { filePath: target.filePath }
          : checkout;
  // A file pane holds the file alone: an empty pane it lands in drops the session id it was minted with.
  const fields: Partial<Omit<PaneState, 'id'>> = { projectId: target.projectId, paneView: shownView, ...items, ...(target.surface === 'file' ? { sessionId: null } : {}) };

  const active = getActivePane();
  if (active && isEmptyPane(active)) {
    // Set directly (not updatePane): the target's surface wins, and a new
    // title/label starts clean.
    const { desks } = mapPaneInDesks(active.id, (pane) => ({ ...pane, terminalFallback: undefined, ...fields, title: undefined }));
    setSnapshot({ ...snapshot, desks });
    return active.id;
  }
  return addPaneNextTo(getActiveDesk().activePaneId, {
    ...fields,
    ...(target.surface === 'session' ? {} : { sessionId: null }),
  });
}

/**
 * Open a session of any space (the sidebar's All view). The space switches
 * first: a pane's desk decides the token and the agent its session starts with.
 */
export function openSessionInSpace(spaceId: string | null, target: OpenTarget): string {
  activateSpace(spaceId);
  return openInPane(target);
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

// ── Worker panes ────────────────────────────────────────────────────
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
 * A worker session another session asked for (skill spawn-session): a chat
 * pane on the requester's desk, right of the requester's pane. The host has
 * started the worker in the chat with its first message already; the pane only
 * joins. A session the host has not started (a task's "Work on it now") names
 * its first message as `prompt`: it goes with the chat's init (chat-start.ts),
 * and the pane's task with it. Focus stays where it is — the user may be typing in the requester.
 * Without a known requester it lands on the active desk. A task run (v0.17)
 * names its desk (`deskId`) and its task.
 *
 * `replacePaneId` (first run: the getting-started session the host opens, see
 * findEmptyDeskPane): that pane — still the only one on its desk — is swapped
 * for the new pane, which becomes active.
 */
export function addWorkerPane(opts: {
  fromSessionId: string | null;
  projectId: string;
  title: string | null;
  deskId?: string;
  /** The space the worker runs in (null = main); picks a desk when no requester pane is known. */
  spaceId?: string | null;
  taskId?: string;
  /** The agent CLI the worker runs with; unset → the cockpit's default. */
  provider?: LLMProvider;
  replacePaneId?: string | null;
  /** The worker's session id, when the host fixed it in advance (the spawn request id — host spawn-api.ts). */
  sessionId?: string;
  /** First message of a session the host has not started yet; empty or unset: the pane only joins. */
  prompt?: string;
}): string {
  const from = opts.fromSessionId
    ? snapshot.desks
        .flatMap(desk => desk.panes.map(pane => ({ desk, pane })))
        .find(({ pane }) => pane.sessionId === opts.fromSessionId)
    : undefined;
  const newPane: PaneState = {
    ...createPane('chat', opts.projectId),
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts.title ? { title: opts.title } : {}),
    ...(opts.taskId ? { taskId: opts.taskId } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  };
  if (opts.prompt) queueChatStart(newPane.sessionId!, { provider: opts.provider ?? null, prompt: opts.prompt, model: null });
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
  if (replaced) {
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
  return newPane.id;
}

// ── The empty pane's launcher (components/session-launcher) ─────────────
/**
 * Start a new session in this (empty) pane, as a chat in the project; its first
 * message goes with the chat's init (components/chat/chat-start.ts).
 * `terminalFallback`: an agent without a chat, in the terminal fallback (only
 * while the switch is on). Returns the new session's id.
 */
export function startSessionInPane(paneId: string, opts: { projectId: string; sessionId?: string; provider?: string | null; terminalFallback?: boolean }): string {
  setTopView('desks');
  const sessionId = opts.sessionId ?? newCliSessionId();
  // The agent the launcher's picker chose: the pane opens as that agent's chat (chatProviderOfPane).
  const provider = (opts.provider ?? undefined) as LLMProvider | undefined;
  const { desks } = mapPaneInDesks(paneId, (pane) => ({
    ...pane, projectId: opts.projectId, sessionId, paneView: 'chat', title: undefined, provider, terminalFallback: opts.terminalFallback || undefined,
  }));
  setSnapshot({ ...snapshot, desks });
  activatePane(paneId);
  return sessionId;
}

/** Continue a session in this (empty) pane, in its chat. */
export function resumeSessionInPane(paneId: string, opts: { projectId: string; sessionId: string }): void {
  setTopView('desks');
  const { desks } = mapPaneInDesks(paneId, (pane) => ({
    ...pane, projectId: opts.projectId, sessionId: opts.sessionId, paneView: 'chat', title: undefined, provider: undefined, terminalFallback: undefined,
  }));
  setSnapshot({ ...snapshot, desks });
  activatePane(paneId);
}

/** The project this desk last started a session in: the launcher's default pick. */
export function lastProjectOfDesk(paneId: string): string | null {
  const desk = getDeskOfPane(paneId);
  return desk?.panes.find((pane) => pane.id !== paneId && pane.projectId)?.projectId ?? desk?.defaultProjectId ?? null;
}
