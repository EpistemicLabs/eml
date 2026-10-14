// Client-side settings persistence: one `cockpit-settings` localStorage blob;
// writes are announced with a window event (same tab), the `storage` event
// covers other tabs.
import { DEFAULT_PROJECT_SORT_ORDER } from '../constants/constants';
import type { CockpitSettings, ProjectSortOrder } from '../types/types';

export const SETTINGS_STORAGE_KEY = 'cockpit-settings';
export const SETTINGS_CHANGED_EVENT = 'cockpit-settings-changed';

const toSortOrder = (value: unknown): ProjectSortOrder => (value === 'date' ? 'date' : DEFAULT_PROJECT_SORT_ORDER);

export function readSettings(): CockpitSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CockpitSettings>) : {};
    return {
      projectSortOrder: toSortOrder(parsed.projectSortOrder),
      notifyOnDone: parsed.notifyOnDone === true,
      lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : undefined,
    };
  } catch {
    return { projectSortOrder: DEFAULT_PROJECT_SORT_ORDER, notifyOnDone: false };
  }
}

export function writeSettings(patch: Partial<CockpitSettings>): CockpitSettings {
  const next: CockpitSettings = { ...readSettings(), ...patch, lastUpdated: new Date().toISOString() };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // non-fatal — the in-memory state still applies for this session
  }
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  return next;
}

/** Subscribe to settings changes from this tab (custom event) or others (storage). */
export function subscribeSettings(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === SETTINGS_STORAGE_KEY) listener();
  };
  window.addEventListener(SETTINGS_CHANGED_EVENT, listener);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
    window.removeEventListener('storage', onStorage);
  };
}
