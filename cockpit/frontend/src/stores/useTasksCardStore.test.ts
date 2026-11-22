// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';

import { useCockpitShortcuts } from '@/components/top-bar/useCockpitShortcuts';

import { setTasksCardPlace, setTasksCardShown, useTasksCard } from './useTasksCardStore';

afterEach(() => { cleanup(); act(() => setTasksCardPlace('left')); });

const key = (k: string) => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('the tasks card place', () => {
  it('sits next to the sidebar by default and is remembered', () => {
    const { result } = renderHook(() => useTasksCard());
    expect(result.current).toEqual({ place: 'left', shown: true });
    act(() => setTasksCardPlace('right'));
    expect(JSON.parse(localStorage.getItem('cockpit-tasks-card')!)).toEqual({ place: 'right', shown: true });
  });

  it('hides and comes back where it was with G then T', () => {
    act(() => setTasksCardPlace('right'));
    const { result } = renderHook(() => { useCockpitShortcuts(() => {}); return useTasksCard(); });
    act(() => { key('g'); key('t'); });
    expect(result.current).toEqual({ place: 'right', shown: false });
    act(() => { key('g'); key('t'); });
    expect(result.current).toEqual({ place: 'right', shown: true });
  });

  it('shows again when a place is picked', () => {
    act(() => setTasksCardShown(false));
    act(() => setTasksCardPlace('left'));
    const { result } = renderHook(() => useTasksCard());
    expect(result.current.shown).toBe(true);
  });
});
