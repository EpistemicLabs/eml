import type { ProjectSession } from '@/types/app';

const NEW_SESSION_NAME = 'New Session';
const PINNED_OPEN_KEY = 'cockpit-sidebar-pinned';

function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the in-memory state still applies
  }
}

/** Whether the sidebar is kept open (else a rail that opens on hover). */
export const readPinnedOpen = (): boolean => readStorage(PINNED_OPEN_KEY) === '1';

export const writePinnedOpen = (pinned: boolean): void => writeStorage(PINNED_OPEN_KEY, pinned ? '1' : '0');

export const sessionDisplayName = (session: ProjectSession): string =>
  session.summary ? session.summary : NEW_SESSION_NAME;

/** `<1m`, `Nm`, `Nhr`, `Nd`; empty for an invalid date. */
export function compactAge(timeString: string, now: Date): string {
  const time = new Date(timeString).getTime();
  if (!timeString || Number.isNaN(time)) return '';
  const minutes = Math.floor(Math.max(0, now.getTime() - time) / 60_000);
  if (minutes < 1) return '<1m';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}hr`;
  return `${Math.floor(hours / 24)}d`;
}
