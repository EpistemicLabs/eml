// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

// The Jobs view is gone: a cockpit that was left on it opens on the task views, where a schedule sits on its task.

afterEach(() => { localStorage.clear(); vi.resetModules(); });

describe('the top view a reload lands on', () => {
  it('is the task views for a cockpit left on Jobs, and stays so', async () => {
    localStorage.setItem('cockpit-top-view', 'jobs');
    const { getTopView } = await import('./useTopViewStore');
    expect(getTopView()).toBe('tasks');
    expect(localStorage.getItem('cockpit-top-view')).toBe('tasks');
  });

  it('is the saved view, or the desks for one it does not know', async () => {
    localStorage.setItem('cockpit-top-view', 'brain');
    expect((await import('./useTopViewStore')).getTopView()).toBe('brain');
    vi.resetModules();
    localStorage.setItem('cockpit-top-view', 'nowhere');
    expect((await import('./useTopViewStore')).getTopView()).toBe('desks');
  });
});
