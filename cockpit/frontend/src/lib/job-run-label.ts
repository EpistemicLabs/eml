// How the Jobs view words a run.

export type RunOutcome = 'done' | 'review' | 'question' | 'failed';

export type LabelRun = {
  status: 'waiting' | 'starting' | 'started' | 'finished' | 'failed' | 'missed' | 'skipped';
  outcome: RunOutcome | null;
};

export type RunTone = 'ok' | 'attention' | 'bad' | 'muted';

/** How a run ended, in a word, and its tone. */
export function runLabel(run: LabelRun): { text: string; tone: RunTone } {
  if (run.status === 'finished') {
    if (run.outcome === 'review') return { text: 'check this', tone: 'attention' };
    if (run.outcome === 'question') return { text: 'needs you', tone: 'attention' };
    if (run.outcome === 'failed') return { text: 'failed', tone: 'bad' };
    return { text: run.outcome ?? 'ended', tone: 'ok' };
  }
  if (run.status === 'failed') return { text: 'failed', tone: 'bad' };
  // A missed run shows only here (the cockpit was down): it stands out.
  if (run.status === 'missed') return { text: 'missed', tone: 'attention' };
  if (run.status === 'skipped') return { text: 'skipped', tone: 'muted' };
  if (run.status === 'waiting') return { text: 'waiting for room', tone: 'muted' };
  return { text: 'running', tone: 'ok' };
}
