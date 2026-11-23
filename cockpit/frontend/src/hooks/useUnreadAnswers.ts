// The Unread fold's sessions, live: the session list, the board and the turn states.
import { useMemo } from 'react';

import type { AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { useTaskBoard } from '@/lib/task-board';
import { unreadAnswers } from '@/lib/unread-answers';
import { useTurnStore } from '@/stores/useTurnStateStore';

export function useUnreadAnswers(): AllSession[] {
  const { sessions } = useAllSessions(true);
  const { data: board } = useTaskBoard();
  const { turns } = useTurnStore();
  return useMemo(
    () => (sessions && board ? unreadAnswers(sessions, board, turns, Date.now()) : []),
    [sessions, board, turns],
  );
}
