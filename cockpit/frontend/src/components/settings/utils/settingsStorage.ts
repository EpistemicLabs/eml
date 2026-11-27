// Client-side settings persistence: one `cockpit-settings` localStorage blob;
// writes are announced with a window event (same tab), the `storage` event
// covers other tabs.
import { DEFAULT_PROJECT_SORT_ORDER } from '../constants/constants';
import type { CockpitSettings, ProjectSortOrder } from '../types/types';

export const SETTINGS_STORAGE_KEY = 'cockpit-settings';
export const SETTINGS_CHANGED_EVENT = 'cockpit-settings-changed';

const toSortOrder = (value: unknown): ProjectSortOrder => (value === 'date' ? 'date' : DEFAULT_PROJECT_SORT_ORDER);

// What this browser stored itself.
function readStored(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Sessions open in the chat only: the view choice ("Open sessions in") a browser
 * stored before is dropped from the blob. Run once when the module loads.
 */
export function dropLegacySettings(): void {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return;
    const stored = readStored();
    if (!('chatDefault' in stored)) return;
    delete stored.chatDefault;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Storage unavailable — nothing to drop.
  }
}

dropLegacySettings();

export function readSettings(): CockpitSettings {
  const stored = readStored();
  return {
    projectSortOrder: toSortOrder(stored.projectSortOrder),
    greetOnStart: stored.greetOnStart !== false,
    lastUpdated: typeof stored.lastUpdated === 'string' ? stored.lastUpdated : undefined,
  };
}

export function writeSettings(patch: Partial<CockpitSettings>): CockpitSettings {
  const next: Record<string, unknown> = { ...readStored(), ...patch, lastUpdated: new Date().toISOString() };
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // non-fatal — the in-memory state still applies for this session
  }
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
  return readSettings();
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
