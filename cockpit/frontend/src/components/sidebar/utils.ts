import type { Project, ProjectSession } from '@/types/app';
import { RECENT_WINDOW_MS } from './view/subcomponents/SidebarProjectNotes';
import type {
  ConversationEntry,
  ConversationGroup,
  ProjectGroups,
  ProjectSortOrder,
  SidebarViewMode,
} from './types';

export const NEW_SESSION_NAME = 'New Session';
export const FALLBACK_ERROR_MESSAGE = 'Something went wrong';

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Storage ──────────────────────────────────────────────────────────

const VIEW_MODE_KEY = 'cockpit-sidebar-mode';
const PINNED_OPEN_KEY = 'cockpit-sidebar-pinned';
const SHOW_OLDER_KEY = 'cockpit-sidebar-show-old-sessions';
const SETTINGS_KEY = 'cockpit-settings';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the in-memory state still applies
  }
}

export const readViewMode = (): SidebarViewMode =>
  readStorage(VIEW_MODE_KEY) === 'conversations' ? 'conversations' : 'projects';

export const writeViewMode = (mode: SidebarViewMode): void => writeStorage(VIEW_MODE_KEY, mode);

export const readPinnedOpen = (): boolean => readStorage(PINNED_OPEN_KEY) === '1';

export const writePinnedOpen = (pinned: boolean): void => writeStorage(PINNED_OPEN_KEY, pinned ? '1' : '0');

export function readShowOlderIds(): string[] {
  const raw = readStorage(SHOW_OLDER_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

/** Re-reads the stored list, adds or removes the project, writes it back. */
export function storeShowOlder(projectId: string, show: boolean): void {
  const ids = readShowOlderIds().filter((id) => id !== projectId);
  if (show) ids.push(projectId);
  writeStorage(SHOW_OLDER_KEY, JSON.stringify(ids));
}

export function readSortOrder(): ProjectSortOrder {
  const raw = readStorage(SETTINGS_KEY);
  if (!raw) return 'name';
  try {
    const parsed = JSON.parse(raw) as { projectSortOrder?: unknown } | null;
    return parsed?.projectSortOrder === 'date' ? 'date' : 'name';
  } catch {
    return 'name';
  }
}

// ── Sessions ─────────────────────────────────────────────────────────

export const sessionDisplayName = (session: ProjectSession): string =>
  session.summary ? session.summary : NEW_SESSION_NAME;

export const sessionTimeString = (session: ProjectSession): string =>
  session.lastActivity || session.createdAt || '';

export const sessionDate = (session: ProjectSession): Date =>
  new Date(session.lastActivity || session.createdAt || 0);

const byDateDescending = (a: ProjectSession, b: ProjectSession) =>
  sessionDate(b).getTime() - sessionDate(a).getTime();

/** A project's sessions, provider defaulted, newest first. */
export function deriveProjectSessions(project: Project): ProjectSession[] {
  return (project.sessions ?? [])
    .map((session) => ({ ...session, __provider: session.__provider ?? 'claude' }))
    .sort(byDateDescending);
}

export function projectLastActivity(sessions: ProjectSession[]): number {
  let latest = 0;
  for (const session of sessions) {
    const time = sessionDate(session).getTime();
    if (time > latest) latest = time;
  }
  return latest;
}

/** `<1m`, `Nm`, `Nhr`, `Nd`; empty for an invalid date. */
export function compactAge(timeString: string, now: Date): string {
  const time = new Date(timeString).getTime();
  if (!timeString || Number.isNaN(time)) return '';
  const minutes = Math.floor(Math.max(0, now.getTime() - time) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}hr`;
  return `${Math.floor(hours / 24)}d`;
}

export function isSessionRecent(
  session: ProjectSession,
  openSessionIds: Set<string>,
  selectedSessionId: string | null,
  nowMs: number,
): boolean {
  if (session.state === 'running' || session.state === 'detached') return true;
  if (openSessionIds.has(session.id)) return true;
  if (selectedSessionId !== null && session.id === selectedSessionId) return true;
  if (session.isPinned === true) return true;
  const time = new Date(session.lastActivity || session.createdAt || '').getTime();
  return Number.isFinite(time) && nowMs - time < RECENT_WINDOW_MS;
}

// ── Projects ─────────────────────────────────────────────────────────

export const isProjectVisible = (project: Project): boolean =>
  !project.hidden && project.brainStatus !== 'archived';

export function sortProjects(
  projects: Project[],
  order: ProjectSortOrder,
  lastActivityOf: (project: Project) => number,
): Project[] {
  const nameOf = (project: Project) => project.displayName || project.projectId;
  return [...projects].sort((a, b) => {
    const starDelta = Number(Boolean(b.isStarred)) - Number(Boolean(a.isStarred));
    if (starDelta !== 0) return starDelta;
    if (order === 'date') return lastActivityOf(b) - lastActivityOf(a);
    return nameOf(a).localeCompare(nameOf(b));
  });
}

export function groupProjects(sorted: Project[]): ProjectGroups {
  const groups: ProjectGroups = { pinned: [], brain: [], folder: [] };
  for (const project of sorted) {
    if (project.isStarred) groups.pinned.push(project);
    else if (project.kind === 'brain') groups.brain.push(project);
    else groups.folder.push(project);
  }
  return groups;
}

const sameCalendarDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** Flat sessions view: pinned first, then by calendar recency. Empty groups omitted. */
export function bucketConversations(
  entries: ConversationEntry[],
  now: Date,
  isPinned: (session: ProjectSession) => boolean,
): ConversationGroup[] {
  const sorted = [...entries].sort((a, b) => byDateDescending(a.session, b.session));
  const yesterday = new Date(now.getTime() - DAY_MS);
  const groups: ConversationGroup[] = [
    { label: 'Pinned', entries: [] },
    { label: 'Today', entries: [] },
    { label: 'Yesterday', entries: [] },
    { label: 'Last 7 days', entries: [] },
    { label: 'Older', entries: [] },
  ];
  for (const entry of sorted) {
    const date = sessionDate(entry.session);
    let index: number;
    if (isPinned(entry.session)) index = 0;
    else if (sameCalendarDay(date, now)) index = 1;
    else if (sameCalendarDay(date, yesterday)) index = 2;
    else if (now.getTime() - date.getTime() < 7 * DAY_MS) index = 3;
    else index = 4;
    groups[index].entries.push(entry);
  }
  return groups.filter((group) => group.entries.length > 0);
}

// ── Host errors ──────────────────────────────────────────────────────

/** The host's `{ error: { message } }`, else the fallback text. */
export async function hostErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: { message?: unknown } | string } | null;
    const error = body?.error;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) return error.message;
  } catch {
    // not JSON
  }
  return FALLBACK_ERROR_MESSAGE;
}
