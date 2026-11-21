// The cockpit's keyboard shortcuts in one list: the shortcut sheet (?) and ⌘K show it, so a
// shortcut is added here or nowhere. Also the bar order of the desks, which ⌘1–9 counts.
import { useSyncExternalStore } from 'react';

import { detectMac } from '@/components/command-palette/paletteSearch';
import type { DeskState } from '@/stores/usePaneStore';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';

export const IS_MAC = detectMac();
/** The modifier as the user's keyboard names it. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

export interface Shortcut {
  /** The keys, in order; "then" separates a sequence. */
  keys: string[];
  label: string;
  group: 'Desks' | 'Tasks' | 'Everywhere';
}

export const SHORTCUTS: Shortcut[] = [
  { keys: [MOD, '1–9'], label: 'Desk 1–9, counted top to bottom in the sidebar', group: 'Desks' },
  { keys: [MOD, '.'], label: 'Open the Inbox from anywhere', group: 'Tasks' },
  { keys: ['G', 'then', 'I'], label: 'Inbox', group: 'Tasks' },
  { keys: ['G', 'then', 'N'], label: 'Now', group: 'Tasks' },
  { keys: ['G', 'then', 'P'], label: 'Plan', group: 'Tasks' },
  { keys: ['Esc'], label: 'Close the task panel or a dialog', group: 'Tasks' },
  { keys: [MOD, 'K'], label: 'Search and commands', group: 'Everywhere' },
  { keys: [MOD, ','], label: 'Settings', group: 'Everywhere' },
  { keys: ['?'], label: 'This list of shortcuts', group: 'Everywhere' },
];

/** The keys of a shortcut as one hint string ("G I", "⌘ ."). */
export const keysHint = (keys: string[]) => keys.filter((k) => k !== 'then').join(' ');

/** Every desk of every space, left to right as the bar shows them: ⌘1–9 counts this order. */
export function orderedDesks(desks: DeskState[], spaces: SpaceInfo[]): DeskState[] {
  if (spaces.length === 0) return desks;
  return spaces.flatMap((space) => desks.filter((desk) => desk.spaceId === paneSpaceKey(space)));
}

// The shortcut sheet's open state: opened by ?, the palette and Settings.
let sheetOpen = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function setShortcutSheet(open: boolean): void {
  sheetOpen = open;
  for (const listener of listeners) listener();
}
export function useShortcutSheet(): boolean {
  return useSyncExternalStore(subscribe, () => sheetOpen);
}
