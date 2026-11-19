// What the Jobs view reads from the host (host jobs-api.ts), and its small helpers.
import * as paneStore from '@/stores/usePaneStore';
import { setTopView } from '@/stores/useTopViewStore';

import { runLabel as label, type RunOutcome } from '@/lib/job-run-label';

export type { RunOutcome };

/** The run's session as it stands now; attention: what it waits for from the user. */
export type SessionInfo = { projectId: string | null; chat: boolean; attention?: RunOutcome | null } | null;

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
  /** What has to be true for the job to be over, set by its agent. */
  goal?: string | null;
  paused: boolean;
  pausedReason: string | null;
  /** New channel addresses wait for the user's OK (Approve). */
  pendingApproval?: boolean;
  /** Per channel: send freely or draft for review. */
  reply: Partial<Record<'mail' | 'slack' | 'whatsapp', 'send' | 'draft'>>;
  triggers: Array<{ type: string }>;
  /** No shell, no messages to sessions, only the brain MCP, the schedule tool for its own job only — unless lent (grants). */
  limited?: boolean;
  grants?: Array<{ tool: 'chrome' | 'SendMessage'; until: string; reason: string | null }>;
  endedAt: string | null;
  createdAt: string;
  notify: 'needs-me' | 'always' | 'never';
  schedule: string;
  wakes: string;
  nextRuns: string[];
  runs: JobRun[];
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

/** Open a run's session, in its space. */
export function openSession(spaceId: string | null, sessionId: string, session: SessionInfo | undefined): void {
  setTopView('desks');
  paneStore.openSessionInSpace(spaceId, {
    surface: 'terminal', projectId: session?.projectId ?? null, sessionId, chat: session?.chat ?? true,
  });
}

/** A run in a word and its tone; `current`: the job's last run, read as its session stands now. */
export function runLabel(run: JobRun, current = false): ReturnType<typeof label> {
  return label({ status: run.status, outcome: run.outcome, attention: run.session?.attention ?? null, sessionKnown: !!run.session }, current);
}
