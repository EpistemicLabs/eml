// Client-side settings persistence: one `cockpit-settings` localStorage blob;
// writes are announced with a window event (same tab), the `storage` event
// covers other tabs.
import { DEFAULT_PROJECT_SORT_ORDER } from '../constants/constants';
import type { CockpitSettings, ProjectSortOrder } from '../types/types';

export const SETTINGS_STORAGE_KEY = 'cockpit-settings';
export const SETTINGS_CHANGED_EVENT = 'cockpit-settings-changed';

const toSortOrder = (value: unknown): ProjectSortOrder => (value === 'date' ? 'date' : DEFAULT_PROJECT_SORT_ORDER);

// The cockpit's chat view switch (Settings › Models, host: the Claude provider's
// settings); a browser without its own choice follows it. On until the host says.
let hostChatView = true;

export function setHostChatView(on: boolean): void {
  if (on === hostChatView) return;
  hostChatView = on;
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

// What this browser stored itself: the browser's own choice of view is
// stored as chatDefault, and only when the user made it.
function readStored(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readSettings(): CockpitSettings {
  const stored = readStored();
  const chatOverride = typeof stored.chatDefault === 'boolean' ? stored.chatDefault : undefined;
  return {
    projectSortOrder: toSortOrder(stored.projectSortOrder),
    notifyOnDone: stored.notifyOnDone === true,
    greetOnStart: stored.greetOnStart !== false,
    chatDefault: chatOverride ?? hostChatView,
    chatOverride,
    lastUpdated: typeof stored.lastUpdated === 'string' ? stored.lastUpdated : undefined,
  };
}

/** chatOverride: true/false is this browser's choice, null goes back to the cockpit's switch. */
export function writeSettings(patch: Partial<Omit<CockpitSettings, 'chatDefault' | 'chatOverride'>> & { chatOverride?: boolean | null }): CockpitSettings {
  const { chatOverride, ...rest } = patch;
  const next: Record<string, unknown> = { ...readStored(), ...rest, lastUpdated: new Date().toISOString() };
  if (chatOverride === null) delete next.chatDefault;
  else if (chatOverride !== undefined) next.chatDefault = chatOverride;
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
