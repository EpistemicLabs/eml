import { beforeEach, describe, expect, it, vi } from 'vitest';

// Where a new Claude session opens: this browser's own choice, else the
// cockpit's chat view switch (Settings › Models).

const storage = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value); },
  removeItem: (key: string) => { storage.delete(key); },
});
vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true });

describe('the chat view setting', () => {
  let settings: typeof import('./settingsStorage');

  beforeEach(async () => {
    vi.resetModules();
    storage.clear();
    settings = await import('./settingsStorage');
  });

  const stored = () => JSON.parse(storage.get('cockpit-settings') ?? '{}') as Record<string, unknown>;

  it('follows the cockpit while the browser has no choice of its own', () => {
    expect(settings.readSettings().chatDefault).toBe(true);
    settings.setHostChatView(false);
    expect(settings.readSettings()).toMatchObject({ chatDefault: false, chatOverride: undefined });
  });

  it("keeps the browser's choice over the cockpit's, until it goes back to the cockpit", () => {
    settings.writeSettings({ chatOverride: true });
    settings.setHostChatView(false);
    expect(settings.readSettings()).toMatchObject({ chatDefault: true, chatOverride: true });
    settings.writeSettings({ chatOverride: null });
    expect(settings.readSettings()).toMatchObject({ chatDefault: false, chatOverride: undefined });
    expect(stored()).not.toHaveProperty('chatDefault');
  });

  it('stores no choice of view when another setting changes', () => {
    settings.writeSettings({ notifyOnDone: true });
    expect(stored()).toMatchObject({ notifyOnDone: true });
    expect(stored()).not.toHaveProperty('chatDefault');
  });

  it('reads a choice stored by an earlier version as the browser\'s own', () => {
    storage.set('cockpit-settings', JSON.stringify({ chatDefault: false }));
    expect(settings.readSettings()).toMatchObject({ chatDefault: false, chatOverride: false });
  });
});
