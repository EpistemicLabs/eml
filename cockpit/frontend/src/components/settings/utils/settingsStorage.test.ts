import { beforeEach, describe, expect, it, vi } from 'vitest';

// Sessions open in the chat only: a view choice an earlier version stored goes.

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

describe('cockpit settings', () => {
  const stored = () => JSON.parse(storage.get('cockpit-settings') ?? '{}') as Record<string, unknown>;

  beforeEach(() => {
    vi.resetModules();
    storage.clear();
  });

  it('drops the view choice an earlier version stored, and keeps the rest', async () => {
    storage.set('cockpit-settings', JSON.stringify({ chatDefault: false, greetOnStart: false }));
    const settings = await import('./settingsStorage');
    expect(stored()).toEqual({ greetOnStart: false });
    expect(settings.readSettings()).toMatchObject({ greetOnStart: false });
    expect(settings.readSettings()).not.toHaveProperty('chatDefault');
  });

  it('writes a change next to what is stored', async () => {
    const settings = await import('./settingsStorage');
    settings.writeSettings({ greetOnStart: false });
    expect(stored()).toMatchObject({ greetOnStart: false });
    settings.writeSettings({ projectSortOrder: 'date' });
    expect(settings.readSettings()).toMatchObject({ greetOnStart: false, projectSortOrder: 'date' });
  });
});
