// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { DEFAULT_TASK_FILTER, setTaskFilter, useTaskFilter } from './useTaskFilterStore';

afterEach(() => { cleanup(); act(() => setTaskFilter(DEFAULT_TASK_FILTER)); localStorage.clear(); });

describe('the task board filter', () => {
  it('starts on Me in all spaces', () => {
    const { result } = renderHook(() => useTaskFilter());
    expect(result.current).toEqual({ everyone: false, spaceId: null });
  });

  it('keeps one pick when the other changes and remembers both', () => {
    const { result } = renderHook(() => useTaskFilter());
    act(() => setTaskFilter({ spaceId: 'ebisu' }));
    act(() => setTaskFilter({ everyone: true }));
    expect(result.current).toEqual({ everyone: true, spaceId: 'ebisu' });
    expect(JSON.parse(localStorage.getItem('cockpit-task-board-filter')!)).toEqual({ everyone: true, spaceId: 'ebisu' });
  });

  it('comes back after a reload, and a broken entry falls back to the default', async () => {
    localStorage.setItem('cockpit-task-board-filter', JSON.stringify({ everyone: true, spaceId: 'atlas' }));
    vi.resetModules();
    expect(renderHook((await import('./useTaskFilterStore')).useTaskFilter).result.current).toEqual({ everyone: true, spaceId: 'atlas' });
    localStorage.setItem('cockpit-task-board-filter', '{not json');
    vi.resetModules();
    expect(renderHook((await import('./useTaskFilterStore')).useTaskFilter).result.current).toEqual({ everyone: false, spaceId: null });
  });
});
