// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { BoardTask } from '@/lib/task-board';
import { setTimeZoneForTest } from '@/lib/time-zone';

import { HandOverDialog } from './HandOverDialog';

// The tests run in UTC. Thu 19 Nov 2026 22:00 UTC is Fri 20 Nov 05:00 in Bangkok.
const NOW = Date.parse('2026-11-19T22:00:00Z');
const task: BoardTask = {
  id: 't', spaceId: 'main', spaceName: 'Main', project: 'acme', title: 'acme-rescue', status: 'active', parentId: null, updatedAt: '2026-11-19T09:00:00Z',
  turn: 'needs_you', group: 'own', coverage: { ok: false, group: 'mine' }, urgency: 0, important: false, sessionIds: [], working: false, nextRunAt: null, hasSchedule: false, owner: 'lasse',
};

afterEach(() => { cleanup(); setTimeZoneForTest(null); });

describe('scheduling a hand-over', () => {
  it('reads its times in the user\'s time zone (Settings), not the browser\'s', () => {
    setTimeZoneForTest('Asia/Bangkok');
    const onSubmit = vi.fn();
    render(<HandOverDialog task={task} mode="schedule" agents={['atlas']} desks={[]} now={NOW} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={onSubmit} />);
    // Tomorrow is Saturday in Bangkok, though it is still Thursday in UTC.
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0].schedule).toEqual({ at: '2026-11-21T09:00', timeZone: 'Asia/Bangkok' });
  });

  it('fills the picker with the user\'s date and names the zone next to it', () => {
    setTimeZoneForTest('Asia/Makassar');
    const onSubmit = vi.fn();
    render(<HandOverDialog task={task} mode="schedule" agents={['atlas']} desks={[]} now={NOW} onClose={() => {}} onAnswerFirst={() => {}} onSubmit={onSubmit} />);
    fireEvent.click(screen.getByRole('button', { name: 'Pick a date…' }));
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2026-11-21');
    expect((screen.getByLabelText('Date') as HTMLInputElement).min).toBe('2026-11-20');
    expect(screen.getByText('Asia/Makassar')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '20:15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    expect(onSubmit.mock.calls[0][0].schedule).toEqual({ at: '2026-11-21T20:15', timeZone: 'Asia/Makassar' });
  });
});
