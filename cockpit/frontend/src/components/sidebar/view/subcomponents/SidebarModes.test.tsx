// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readViewMode, writeViewMode } from '../../utils';
import { SidebarModes } from './SidebarChrome';

// Above their list: the overview, marked beta, then Projects and Sessions.
// Projects is the default, and the browser remembers the last one.

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('the sidebar views', () => {
  it('offers the three, the overview marked beta', () => {
    render(<SidebarModes viewMode="projects" onViewModeChange={() => {}} waiting={0} />);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Overviewβ', 'Projects', 'Sessions']);
    expect(screen.getByRole('tab', { name: /Projects/ }).getAttribute('aria-selected')).toBe('true');
  });

  it('counts what waits on the overview\'s tab while another view is open', () => {
    const { rerender } = render(<SidebarModes viewMode="projects" onViewModeChange={() => {}} waiting={3} />);
    expect(screen.getByLabelText('3 waiting')).toBeTruthy();
    rerender(<SidebarModes viewMode="overview" onViewModeChange={() => {}} waiting={3} />);
    expect(screen.queryByLabelText('3 waiting')).toBeNull();
  });

  it('switches on a click', () => {
    const change = vi.fn();
    render(<SidebarModes viewMode="projects" onViewModeChange={change} waiting={0} />);
    fireEvent.click(screen.getByRole('tab', { name: /Overview/ }));
    expect(change).toHaveBeenCalledWith('overview');
  });

  it('starts on Projects and remembers the last view', () => {
    expect(readViewMode()).toBe('projects');
    writeViewMode('overview');
    expect(readViewMode()).toBe('overview');
    writeViewMode('conversations');
    expect(readViewMode()).toBe('conversations');
    // A value an older or newer cockpit stored falls back to the default.
    writeViewMode('inbox' as never);
    expect(readViewMode()).toBe('projects');
  });
});
