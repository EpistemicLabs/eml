import { createContext, useContext } from 'react';

import type { Note } from '@/lib/notes';
import type { Project, ProjectSession } from '@/types/app';

export type RowMenuTarget =
  | { kind: 'session'; session: ProjectSession; projectId: string }
  | { kind: 'project'; project: Project }
  | { kind: 'note'; note: Note; project: Project };

export interface RowMenuApi {
  /** Opens the menu at the given row. */
  open: (target: RowMenuTarget, row: Element | null) => void;
  isSessionPinned: (session: ProjectSession) => boolean;
}

export const RowMenuContext = createContext<RowMenuApi | null>(null);

/** Given only in the compact layout, where a row's actions live in a menu instead of on hover. */
export function useRowMenu(): RowMenuApi | null {
  return useContext(RowMenuContext);
}

const MARGIN_PX = 8;

/** Where a menu goes: under its row, or over it where it wouldn't fit, against the right side and always on screen. */
export function rowMenuPosition(
  row: { top: number; bottom: number; right: number },
  menu: { width: number; height: number },
  view: { width: number; height: number },
): { top: number; left: number } {
  const below = row.bottom + MARGIN_PX;
  const fitsBelow = below + menu.height <= view.height - MARGIN_PX;
  const top = fitsBelow ? below : row.top - MARGIN_PX - menu.height;
  const left = Math.min(row.right, view.width - MARGIN_PX) - menu.width;
  return { top: Math.max(MARGIN_PX, top), left: Math.max(MARGIN_PX, left) };
}
