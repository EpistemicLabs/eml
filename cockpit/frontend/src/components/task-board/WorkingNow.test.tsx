// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import type { WorkingRow } from '@/lib/working-now';

import { WorkingColumn, WorkingStrip } from './WorkingNow';

const row = (patch: Partial<WorkingRow> = {}): WorkingRow => ({
  key: 'w', sessionId: 'w', task: undefined, letter: 'A', agent: 'Atlas', name: 'Grade the batches', where: 'Main · UI',
  kind: 'worker', since: '2026-02-01T11:00:00.000Z', step: 'Grading the batches', waiting: null, ...patch,
});
const now = Date.parse('2026-02-01T11:05:00.000Z');
const noop = () => {};

afterEach(cleanup);

describe('Working now', () => {
  it('shows what a row waits for in place of its status line, in the column', () => {
    render(<WorkingColumn rows={[row({ waiting: 'Waiting for 2 subagents' })]} next={[]} now={now} current={null} onOpen={noop} onOpenTask={noop} onShowNow={noop} />);
    expect(screen.getByText('Waiting for 2 subagents')).toBeTruthy();
    expect(screen.queryByText('Grading the batches')).toBeNull();
  });

  it('shows the status line of a row whose own turn runs, in the column', () => {
    render(<WorkingColumn rows={[row()]} next={[]} now={now} current={null} onOpen={noop} onOpenTask={noop} onShowNow={noop} />);
    expect(screen.getByText('Grading the batches')).toBeTruthy();
  });

  it('shows what a row waits for in place of its status line, in the strip', () => {
    render(<WorkingStrip rows={[row({ waiting: 'Waiting for 1 subagent' })]} now={now} onOpen={noop} />);
    expect(screen.getByText('Waiting for 1 subagent')).toBeTruthy();
    expect(screen.queryByText('Grading the batches')).toBeNull();
  });
});
