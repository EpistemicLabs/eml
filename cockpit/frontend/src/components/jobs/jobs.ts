// What the Jobs view and the bell read from the host (host jobs-api.ts,
// notifications.ts), and the small helpers both use.
import * as paneStore from '@/stores/usePaneStore';
import { setTopView } from '@/stores/useTopViewStore';

export type RunOutcome = 'done' | 'review' | 'question' | 'failed';

export type SessionInfo = { projectId: string | null; chat: boolean } | null;

export type JobRun = {
  id: string;
  number: number;
  trigger: string;
  dueAt: string;
  status: 'waiting' | 'starting' | 'started' | 'finished' | 'failed' | 'missed' | 'skipped';
  sessionId: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  outcome: RunOutcome | null;
  note: string | null;
  session: SessionInfo;
};

export type Job = {
  id: string;
  name: string;
  spaceId: string | null;
  spaceName: string;
  prompt: string;
  paused: boolean;
  pausedReason: string | null;
  /** New channel addresses wait for the user's OK (Approve). */
  pendingApproval?: boolean;
  /** Per channel: send freely or draft for review. */
  reply: Partial<Record<'mail' | 'slack' | 'whatsapp', 'send' | 'draft'>>;
  triggers: Array<{ type: string }>;
  endedAt: string | null;
  createdAt: string;
  notify: 'needs-me' | 'always' | 'never';
  schedule: string;
  wakes: string;
  nextRuns: string[];
  runs: JobRun[];
};

export type CockpitNotification = {
  id: string;
  at: string;
  kind: 'review' | 'question' | 'failed' | 'done' | 'missed' | 'paused';
  title: string;
  body: string;
  jobId: string | null;
  sessionId: string | null;
  spaceId: string | null;
  read: boolean;
  session?: SessionInfo;
};

/** "Mon 9 Nov 08:00", in this browser's zone — the zone jobs read in by default. */
export function formatWhen(iso: string): string {
  const at = new Date(iso);
  const sameYear = at.getFullYear() === new Date().getFullYear();
  return at.toLocaleString('en-GB', {
    weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).replace(',', '');
}

/** "5 min ago", "3 h ago", "2 days ago". */
export function formatAgo(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (24 * 60))} days ago`;
}

/** Open the session a run or a notification points at, in its space. */
export function openSession(spaceId: string | null, sessionId: string, session: SessionInfo | undefined): void {
  setTopView('desks');
  paneStore.openSessionInSpace(spaceId, {
    surface: 'terminal', projectId: session?.projectId ?? null, sessionId, chat: session?.chat ?? true,
  });
}

/** How a run ended, in a word, and its tone. */
export function runLabel(run: JobRun): { text: string; tone: 'ok' | 'attention' | 'bad' | 'muted' } {
  if (run.status === 'finished') {
    if (run.outcome === 'review') return { text: 'check this', tone: 'attention' };
    if (run.outcome === 'question') return { text: 'needs you', tone: 'attention' };
    if (run.outcome === 'failed') return { text: 'failed', tone: 'bad' };
    return { text: run.outcome ?? 'ended', tone: 'ok' };
  }
  if (run.status === 'failed') return { text: 'failed', tone: 'bad' };
  if (run.status === 'missed' || run.status === 'skipped') return { text: run.status, tone: 'muted' };
  if (run.status === 'waiting') return { text: 'waiting for room', tone: 'muted' };
  return { text: 'running', tone: 'ok' };
}
