import { describe, expect, it } from 'vitest';

import { runLabel } from './job-run-label';

// How the Jobs view words a run.

describe('runLabel', () => {
  it('words a finished run by what its session said', () => {
    expect(runLabel({ status: 'finished', outcome: 'question' })).toEqual({ text: 'needs you', tone: 'attention' });
    expect(runLabel({ status: 'finished', outcome: 'review' })).toEqual({ text: 'check this', tone: 'attention' });
    expect(runLabel({ status: 'finished', outcome: 'failed' })).toEqual({ text: 'failed', tone: 'bad' });
    expect(runLabel({ status: 'finished', outcome: 'done' })).toEqual({ text: 'done', tone: 'ok' });
    expect(runLabel({ status: 'finished', outcome: null })).toEqual({ text: 'ended', tone: 'ok' });
  });

  it('labels runs that did not finish', () => {
    expect(runLabel({ status: 'missed', outcome: null })).toEqual({ text: 'missed', tone: 'attention' });
    expect(runLabel({ status: 'skipped', outcome: null })).toEqual({ text: 'skipped', tone: 'muted' });
    expect(runLabel({ status: 'waiting', outcome: null })).toEqual({ text: 'waiting for room', tone: 'muted' });
    expect(runLabel({ status: 'failed', outcome: null })).toEqual({ text: 'failed', tone: 'bad' });
    expect(runLabel({ status: 'started', outcome: null })).toEqual({ text: 'running', tone: 'ok' });
  });
});
