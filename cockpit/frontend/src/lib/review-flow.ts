import { closePane } from '@/lib/pane-close';
import { archiveSession, clearSession, markSessionRead } from '@/lib/session-actions';
import {
  getActiveDesk,
  getActiveSpaceId,
  getDeskOfPane,
  getPane,
  isPaneProtected,
  openSessionInSpace,
  paneHoldingSession,
  showSessionInPane,
} from '@/stores/usePaneStore';
import { getReview, pruneQueue, queueAfter, setReview, type ReviewState } from '@/stores/useReviewStore';
import { paneSpaceKey, type SpaceInfo } from '@/stores/useSpaceStore';
import { api } from '@/utils/api';
import type { AllSession } from '@/components/sidebar/allSessions';

/**
 * Show the session in the review pane. The flow's own pane swaps its session in
 * place, so going on adds and removes no pane. A session open in a pane of the
 * user's on this desk (or one they keep) is shown there for that step, and the
 * flow's pane stays where it is for the next one. A pane only opens for the
 * first session and for a session of another space (its desk decides the token).
 */
function show(session: AllSession, spaces: SpaceInfo[], queue: string[], index: number): void {
  const previous = getReview();
  const space = spaces.find((candidate) => candidate.id === session.spaceId) ?? spaces[0];
  const spaceKey = space ? paneSpaceKey(space) : null;
  const target = { surface: 'terminal', projectId: session.__projectId ?? null, sessionId: session.id, chat: session.runtime === 'sdk' } as const;
  const own = previous?.ownPaneId && getPane(previous.ownPaneId) ? previous.ownPaneId : null;

  const holder = paneHoldingSession(session.id);
  if (holder && holder.id === own) {
    setReview({ queue, index, paneId: own, ownPaneId: own });
  } else if (holder && (isPaneProtected(holder.id) || getDeskOfPane(holder.id)?.id === getActiveDesk().id)) {
    // Open in a pane of the user's on this desk, or one they keep: shown there, it stays
    // theirs, and the flow's own pane waits where it is, so the layout doesn't change.
    openSessionInSpace(getDeskOfPane(holder.id)?.spaceId ?? spaceKey, target);
    setReview({ queue, index, paneId: holder.id, ownPaneId: own });
  } else {
    // Open on another desk: it moves into the review pane, one session in one pane.
    if (holder) closePane(holder.id);
    if (own && getDeskOfPane(own)?.spaceId === spaceKey) {
      release(own);
      showSessionInPane(own, target);
      setReview({ queue, index, paneId: own, ownPaneId: own });
    } else {
      const paneId = openSessionInSpace(spaceKey, target);
      if (own && own !== paneId) closePane(own);
      setReview({ queue, index, paneId, ownPaneId: paneId });
    }
  }
  void markSessionRead(session.id);
}

/** The pane lets go of its terminal session before it shows another, as closing it would. */
function release(paneId: string): void {
  const pane = getPane(paneId);
  if (pane?.paneView === 'terminal' && pane.sessionId) {
    void api.releaseSession(pane.sessionId, paneId).catch(() => {
      // Unreachable host: a kept session then stays kept until it is closed again.
    });
  }
}

/** The open space's sessions first, then space by space: the desk changes at most once per space. */
export function orderBySpace(sessions: AllSession[], spaces: SpaceInfo[], openSpace: string | null): AllSession[] {
  const rank = (session: AllSession) => {
    const position = spaces.findIndex((candidate) => candidate.id === session.spaceId);
    if (position === -1) return spaces.length;
    return paneSpaceKey(spaces[position]) === openSpace ? -1 : position;
  };
  return sessions
    .map((session, position) => ({ session, position, rank: rank(session) }))
    .sort((a, b) => a.rank - b.rank || a.position - b.position)
    .map(({ session }) => session);
}

export function startReview(sessions: AllSession[], spaces: SpaceInfo[]): void {
  const ordered = orderBySpace(sessions, spaces, getActiveSpaceId());
  if (ordered.length === 0) return;
  show(ordered[0], spaces, ordered.map((session) => session.id), 0);
}

export function endReview(): void {
  const review = getReview();
  setReview(null);
  if (review?.ownPaneId) closePane(review.ownPaneId);
}

/** The queue as it stands: what left the lists is out. */
export function liveQueue(review: ReviewState, sessions: AllSession[]): { queue: string[]; index: number } {
  const listed = new Set(sessions.filter((session) => !session.archivedAt).map((session) => session.id));
  return pruneQueue(review.queue, review.index, listed);
}

/** Next or previous; past either end nothing happens. */
export function stepReview(step: 1 | -1, sessions: AllSession[], spaces: SpaceInfo[]): void {
  const review = getReview();
  if (!review) return;
  const { queue, index } = liveQueue(review, sessions);
  const session = sessions.find((candidate) => candidate.id === queue[index + step]);
  if (session) show(session, spaces, queue, index + step);
}

function moveOn(sessions: AllSession[], spaces: SpaceInfo[]): void {
  const review = getReview();
  if (!review) return;
  const live = liveQueue(review, sessions);
  const { queue, index } = queueAfter(live.queue, live.index);
  const session = sessions.find((candidate) => candidate.id === queue[index]);
  if (session) show(session, spaces, queue, index);
  else endReview();
}

/** Take the current one out (archive, or clear for a pinned one) and go on; after the last the flow ends. */
export async function finishCurrent(
  action: 'archive' | 'clear',
  sessions: AllSession[],
  spaces: SpaceInfo[],
): Promise<string | null> {
  const review = getReview();
  if (!review) return null;
  const id = review.queue[review.index];
  // The pane moves on first: archiving closes a pane still showing the session.
  moveOn(sessions, spaces);
  return action === 'archive' ? archiveSession(id) : clearSession(id);
}
