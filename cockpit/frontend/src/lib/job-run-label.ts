// How a run of a task's schedule is worded (the task panel's last runs): the newest
// run as its session stands now, older runs as they ended.

export type RunOutcome = 'done' | 'review' | 'question' | 'failed';

export type LabelRun = {
  status: 'waiting' | 'starting' | 'started' | 'finished' | 'failed' | 'missed' | 'skipped';
  outcome: RunOutcome | null;
  /** What the run's session waits for now (its Needs you / Check this); null once the user took it up. */
  attention: RunOutcome | null;
  /** The run's session still exists. */
  sessionKnown: boolean;
};

export type RunTone = 'ok' | 'attention' | 'bad' | 'muted';

const WAITS: Partial<Record<RunOutcome, { text: string; tone: RunTone }>> = {
  question: { text: 'needs you', tone: 'attention' },
  review: { text: 'check this', tone: 'attention' },
  failed: { text: 'failed', tone: 'bad' },
};

// What a question or a result reads as once the user took it up in the session.
const TAKEN_UP: Partial<Record<RunOutcome, string>> = { question: 'answered', review: 'seen' };

/** A run in a word, and its tone. `current`: the task's newest run, read as its session stands now. */
export function runLabel(run: LabelRun, current: boolean): { text: string; tone: RunTone } {
  if (run.status === 'finished') {
    if (current && run.sessionKnown) {
      const waits = run.attention ? WAITS[run.attention] : undefined;
      if (waits) return waits;
      const taken = run.outcome ? TAKEN_UP[run.outcome] : undefined;
      if (taken) return { text: taken, tone: 'muted' };
    }
    const ended = run.outcome ? WAITS[run.outcome] : undefined;
    return ended ?? { text: run.outcome ?? 'ended', tone: 'ok' };
  }
  if (run.status === 'failed') return { text: 'failed', tone: 'bad' };
  // A missed run shows only here (the cockpit was down): it stands out.
  if (run.status === 'missed') return { text: 'missed', tone: 'attention' };
  if (run.status === 'skipped') return { text: 'skipped', tone: 'muted' };
  if (run.status === 'waiting') return { text: 'waiting for room', tone: 'muted' };
  return { text: 'running', tone: 'ok' };
}
