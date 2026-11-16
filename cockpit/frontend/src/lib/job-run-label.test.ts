import { describe, expect, it } from 'vitest';

import { runLabel, splitEnded, type LabelRun } from './job-run-label';

// A job's last run reads as its session stands now: an answered question no
// longer says "needs you", and ended jobs fold away.

const finished = (outcome: LabelRun['outcome'], attention: LabelRun['attention'] = null, known = true): LabelRun =>
  ({ status: 'finished', outcome, attention, sessionKnown: known });

describe('runLabel', () => {
  it('shows what the session needs now when it still waits', () => {
    expect(runLabel(finished('question', 'question'), true)).toEqual({ text: 'needs you', tone: 'attention' });
    expect(runLabel(finished('done', 'review'), true)).toEqual({ text: 'check this', tone: 'attention' });
  });

  it('shows a question or a result as answered or seen once the user took it up in the session', () => {
    expect(runLabel(finished('question'), true)).toEqual({ text: 'answered', tone: 'muted' });
    expect(runLabel(finished('review'), true)).toEqual({ text: 'seen', tone: 'muted' });
  });

  it('keeps what a run said in the history, and when its session is gone', () => {
    expect(runLabel(finished('question'), false)).toEqual({ text: 'needs you', tone: 'attention' });
    expect(runLabel(finished('question', null, false), true)).toEqual({ text: 'needs you', tone: 'attention' });
    expect(runLabel(finished('failed'), true)).toEqual({ text: 'failed', tone: 'bad' });
    expect(runLabel(finished('done'), true)).toEqual({ text: 'done', tone: 'ok' });
  });

  it('labels runs that did not finish', () => {
    expect(runLabel({ status: 'missed', outcome: null, attention: null, sessionKnown: false }, true)).toEqual({ text: 'missed', tone: 'attention' });
    expect(runLabel({ status: 'started', outcome: null, attention: null, sessionKnown: true }, true)).toEqual({ text: 'running', tone: 'ok' });
  });
});

describe('splitEnded', () => {
  it('keeps running jobs in place and folds the ended ones apart', () => {
    const jobs = [{ id: 'a', endedAt: null }, { id: 'b', endedAt: '2026-11-10T00:00:00Z' }, { id: 'c', endedAt: null }];
    expect(splitEnded(jobs)).toEqual({ open: [jobs[0], jobs[2]], ended: [jobs[1]] });
  });
});
