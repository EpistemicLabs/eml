import { useCallback, useState } from 'react';

import type { SidebarError } from './types';
import { readPinnedOpen, writePinnedOpen } from './utils';

/** The sidebar's own state: kept open or a rail (remembered), and the last failed action's message. */
export function useSidebarState() {
  const [isPinnedOpen, setPinnedOpen] = useState(readPinnedOpen);
  const togglePinnedOpen = useCallback(() => {
    setPinnedOpen((pinned) => {
      writePinnedOpen(!pinned);
      return !pinned;
    });
  }, []);
  const [error, setError] = useState<SidebarError | null>(null);
  const reportError = useCallback((message: string) => setError((current) => ({ id: (current?.id ?? 0) + 1, message })), []);
  const dismissError = useCallback(() => setError(null), []);
  return { isPinnedOpen, togglePinnedOpen, error, reportError, dismissError };
}
