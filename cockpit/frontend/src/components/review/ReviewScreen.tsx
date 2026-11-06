import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Archive, Check, ChevronLeft, ChevronRight, ExternalLink, MessageSquareReply, X } from 'lucide-react';

import { ChatPane } from '@/components/chat/ChatPane';
import { MARK_WORD, agentLabel, allSessionState, sessionMark, type AllSession, type SessionMark } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { compactAge, sessionDisplayName } from '@/components/sidebar/utils';
import StandaloneShell from '@/components/standalone-shell/view/StandaloneShell';
import { endReview, finishCurrent, liveQueue, stepReview } from '@/lib/review-flow';
import { cn } from '@/lib/utils';
import { openSessionInSpace } from '@/stores/usePaneStore';
import { REVIEW_PANE_ID, reclaimTerminal, setReviewBarFocus, useReview } from '@/stores/useReviewStore';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';

const BUTTON =
  'flex h-8 min-w-8 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40';

const NEEDS_YOU: readonly SessionMark[] = ['question', 'failed', 'waiting'];
// Still waiting for an answer: Done drops it only on a second press.
const ASKS: readonly SessionMark[] = ['question', 'waiting'];
const CONFIRM_MS = 3000;

// Dimmed while the bar doesn't hold the keyboard: then the keys go elsewhere.
function KeyHint({ children }: { children: string }) {
  return (
    <kbd className="hidden rounded border border-border px-1 text-[10px] text-muted-foreground opacity-40 group-focus-within:opacity-100 md:inline">
      {children}
    </kbd>
  );
}

/** Keys only while nothing is being typed: the session's input and terminal keep theirs. */
const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"], .xterm'));
};

/**
 * The review: a screen of its own next to the desks and the brain, which stay as
 * they are underneath. One session at a time, full width, ending in its own
 * closing summary; on top where the queue stands and the few facts the cockpit
 * knows itself, so the session's word is not the only one. The bar holds the
 * keyboard and is the same for every session: D goes on, A goes back, R goes to
 * the input, E is Done (the mark goes, the session stays where it is listed), X is
 * Archive (stopped and put away with its finished workers), Esc goes back to the
 * desks. Done on a session still waiting for an answer takes a second press;
 * Archive says why it can't when the session is pinned or still running something.
 * A reply sent from the input gives the keyboard back.
 */
export function ReviewScreen() {
  const review = useReview();
  const spaces = useSpaces();
  const { turns } = useTurnStore();
  const { sessions } = useAllSessions(true);
  const [error, setError] = useState<string | null>(null);
  // The session whose Done waits for its second press.
  const [confirming, setConfirming] = useState<string | null>(null);
  const busy = useRef(false);
  const barRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const known = useMemo<AllSession[]>(() => sessions ?? [], [sessions]);
  const currentId = review?.queue[review.index];
  const current = known.find((session) => session.id === currentId);
  const space = spaces.find((candidate) => candidate.id === current?.spaceId);
  const mark = current ? sessionMark(current, turns[current.id]) : null;
  const asks = mark !== null && ASKS.includes(mark);
  // Why Archive can't, or null: a pin is kept on purpose, and running work would be cut off.
  const archiveBlock = !current ? null
    : current.isPinned ? 'Pinned: unpin it to archive it.'
    : allSessionState(current, turns[current.id]) === 'working' ? 'Still working. Stop it or wait until it finishes.'
    : (current.backgroundTasks ?? 0) > 0 ? 'A background task is still running. Stop it or wait until it finishes.'
    : null;

  const focusBar = () => barRef.current?.focus({ preventScroll: true });
  // Each session starts with the keyboard on the bar: a key never lands in an input by itself.
  useEffect(() => {
    setError(null);
    setConfirming(null);
    focusBar();
  }, [currentId]);
  useEffect(() => {
    if (!confirming) return;
    const timer = setTimeout(() => setConfirming(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [confirming]);
  useEffect(() => {
    setReviewBarFocus(focusBar);
    return () => setReviewBarFocus(null);
  }, []);
  // A terminal session was borrowed from its pane: the pane takes it back once the screen moves on.
  const terminal = current?.runtime !== 'sdk';
  useEffect(() => {
    if (!currentId || !terminal) return;
    return () => reclaimTerminal(currentId);
  }, [currentId, terminal]);

  const move = (step: 1 | -1) => stepReview(step, known);
  const finish = (how: 'archive' | 'clear') => {
    if (!current || busy.current) return;
    busy.current = true;
    setError(null);
    setConfirming(null);
    void finishCurrent(how, known).then((problem) => {
      busy.current = false;
      setError(problem);
    });
  };
  const done = () => {
    if (asks && confirming !== current?.id) {
      setConfirming(current?.id ?? null);
      return;
    }
    finish('clear');
  };
  const archive = () => {
    if (archiveBlock) setError(archiveBlock);
    else finish('archive');
  };
  const reply = () => bodyRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  const openInPane = () => {
    if (!current) return;
    endReview();
    openSessionInSpace(space ? paneSpaceKey(space) : null, {
      surface: 'terminal', projectId: current.__projectId ?? null, sessionId: current.id, chat: current.runtime === 'sdk',
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    const keys: Record<string, () => void> = {
      d: () => move(1),
      a: () => move(-1),
      e: done,
      x: archive,
      r: reply,
      Escape: endReview,
    };
    const run = keys[event.key];
    if (!run) return;
    // Handled here and nowhere else: Escape must not also stop the session below.
    event.preventDefault();
    event.stopPropagation();
    run();
  };

  if (!review) return null;
  const live = liveQueue(review, known);
  const rest = live.queue.map((id) => known.find((session) => session.id === id)).filter((session): session is AllSession => Boolean(session));
  const needYou = rest.filter((session) => {
    const restMark = sessionMark(session, turns[session.id]);
    return restMark !== null && NEEDS_YOU.includes(restMark);
  }).length;
  // Opened, a result without a request has left the list: the bar keeps saying what it was.
  const word = mark ? MARK_WORD[mark] : current?.attention?.kind === 'done' ? MARK_WORD.result : null;
  const parent = current?.parentSessionId ? known.find((session) => session.id === current.parentSessionId) : undefined;
  const now = new Date();
  // What the cockpit knows itself, next to what the session says about its work.
  const facts = current ? [
    space && agentLabel(space),
    parent && `from ${sessionDisplayName(parent)}`,
    current.createdAt && `started ${compactAge(current.createdAt, now)} ago`,
    current.lastActivity && `last active ${compactAge(current.lastActivity as string, now)} ago`,
    current.state === 'running' || current.state === 'detached' ? 'running' : 'stopped',
    current.runtime === 'sdk' ? null : 'terminal',
  ].filter(Boolean).join(' · ') : '';

  return (
    <div className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-background">
      <div
        ref={barRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        aria-label="Review"
        className="group flex-shrink-0 border-b border-border bg-muted/40 px-3 py-2 outline-none"
      >
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="mr-auto min-w-0 truncate text-xs text-muted-foreground">
            <span className="font-medium text-foreground">Review</span>
            <span className="pl-1.5">{live.index + 1} of {live.queue.length}</span>
            {needYou > 0 && <span className="pl-1.5 text-primary">· {needYou} need{needYou === 1 ? 's' : ''} you</span>}
          </span>
          <button type="button" className={BUTTON} disabled={live.index <= 0} onClick={() => move(-1)} aria-label="Previous">
            <ChevronLeft className="h-3.5 w-3.5" /> <KeyHint>A</KeyHint>
          </button>
          <button type="button" className={BUTTON} disabled={live.index >= live.queue.length - 1} onClick={() => move(1)} aria-label="Next">
            <KeyHint>D</KeyHint> <ChevronRight className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={BUTTON} onClick={reply}>
            <MessageSquareReply className="h-3.5 w-3.5" /> Reply <KeyHint>R</KeyHint>
          </button>
          <button type="button" className={`${BUTTON} font-medium`} onClick={done} title="Done: the mark goes, the session stays where it is listed">
            <Check className="h-3.5 w-3.5" />
            {confirming && confirming === current?.id ? 'Press again to drop it' : 'Done & next'} <KeyHint>E</KeyHint>
          </button>
          <button
            type="button"
            className={cn(BUTTON, archiveBlock && 'opacity-40')}
            onClick={archive}
            aria-disabled={Boolean(archiveBlock)}
            title={archiveBlock ?? 'Archive: stopped and put away, with its finished workers'}
          >
            <Archive className="h-3.5 w-3.5" /> Archive &amp; next <KeyHint>X</KeyHint>
          </button>
          <button type="button" className={BUTTON} onClick={openInPane} aria-label="Open in a pane" title="Open in a pane">
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button type="button" className={BUTTON} onClick={endReview} aria-label="Back to the desks" title="Back to the desks (Esc)">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        {current && (
          <div className="mt-1.5 min-w-0 space-y-0.5">
            <p className="truncate text-sm font-medium text-foreground">{sessionDisplayName(current)}</p>
            <p className="truncate text-[11px] text-muted-foreground" title={current.attention?.reason ?? undefined}>
              {word && (
                <span className={cn('font-medium', mark === 'failed' ? 'text-destructive' : mark && NEEDS_YOU.includes(mark) ? 'text-primary' : 'text-foreground')}>
                  {word}{current.attention?.reason ? `: ${current.attention.reason}` : ''}
                </span>
              )}
              {word && facts && ' · '}
              {facts}
            </p>
          </div>
        )}
        {error && <p role="alert" className="mt-1 text-[11px] text-destructive">{error}</p>}
      </div>
      <div ref={bodyRef} className="relative min-h-0 flex-1">
        {!current ? (
          <p className="p-4 text-xs text-muted-foreground">Loading…</p>
        ) : !current.__projectId ? (
          <p className="p-4 text-xs text-muted-foreground">This session has no project to open it in.</p>
        ) : current.runtime === 'sdk' ? (
          <ChatPane
            key={current.id}
            paneId={REVIEW_PANE_ID}
            projectId={current.__projectId}
            sessionId={current.id}
            session={current}
            isActive
            spaceId={space ? paneSpaceKey(space) : null}
          />
        ) : (
          <StandaloneShell
            key={current.id}
            paneId={REVIEW_PANE_ID}
            projectId={current.__projectId}
            sessionId={current.id}
            sessionTitle={sessionDisplayName(current)}
            isActive={false}
            spaceId={space ? paneSpaceKey(space) : null}
          />
        )}
      </div>
    </div>
  );
}
