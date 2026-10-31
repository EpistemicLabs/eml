import { createContext, useContext } from 'react';

import type { Note } from '@/lib/notes';
import type { Project, ProjectSession } from '@/types/app';

export type RowSheetTarget =
  | { kind: 'session'; session: ProjectSession; projectId: string }
  | { kind: 'project'; project: Project }
  | { kind: 'note'; note: Note; project: Project };

export interface RowSheetApi {
  open: (target: RowSheetTarget) => void;
  isSessionPinned: (session: ProjectSession) => boolean;
}

export const RowSheetContext = createContext<RowSheetApi | null>(null);

/** Given only in the compact layout, where a row's actions live in a sheet instead of on hover. */
export function useRowSheet(): RowSheetApi | null {
  return useContext(RowSheetContext);
}
