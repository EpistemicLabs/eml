// The Unread fold's sessions, live: the session list, the board and the turn states.
import { useMemo } from 'react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { useTurnStore } from '@/stores/useTurnStateStore';

import { useTaskBoard } from './task-board';
import { unreadAnswers } from './unread-answers';

export function useUnreadAnswers() {
  const { sessions } = useAllSessions(true);
  const { data: board } = useTaskBoard();
  const { turns } = useTurnStore();
  return useMemo(
    () => (sessions && board ? unreadAnswers(sessions, board, turns, Date.now()) : []),
    [sessions, board, turns],
  );
}
