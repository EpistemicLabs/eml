import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, Check, ChevronLeft, ChevronRight, MessageSquareReply, X } from 'lucide-react';

import { MARK_WORD, sessionMark, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { endReview, finishCurrent, stepReview } from '@/lib/review-flow';
import { useReview } from '@/stores/useReviewStore';
import { useSpaces } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';

const BUTTON =
  'flex h-8 min-w-8 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40';

function KeyHint({ children }: { children: string }) {
  return <kbd className="hidden rounded border border-border px-1 text-[10px] text-muted-foreground md:inline">{children}</kbd>;
}

/** Keys only while nothing is being typed: a chat input and a terminal keep theirs. */
const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"], .xterm'));
};

/**
 * The review flow's bar on top of its pane: where it is in the queue, and what
 * takes the session out. J and K move, E takes it out and goes on, R goes to the
 * reply box, Esc ends the flow. A phone gets the same buttons.
 */
export function ReviewBar({ paneId }: { paneId: string }) {
  const review = useReview();
  if (review?.paneId !== paneId) return null;
  return <ActiveReviewBar />;
}

function ActiveReviewBar() {
  const review = useReview();
  const spaces = useSpaces();
  const { turns } = useTurnStore();
  const { sessions } = useAllSessions(true);
  const [error, setError] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  const known = useMemo<AllSession[]>(() => sessions ?? [], [sessions]);
  const current = known.find((session) => session.id === review?.queue[review.index]);
  const pinned = Boolean(current?.isPinned);
  const action: 'archive' | 'clear' = pinned ? 'clear' : 'archive';

  const move = (step: 1 | -1) => stepReview(step, known, spaces);
  const finish = () => {
    setError(null);
    void finishCurrent(action, known, spaces).then(setError);
  };
  const reply = () => {
    const pane = barRef.current?.parentElement;
    pane?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === 'j') move(1);
      else if (event.key === 'k') move(-1);
      else if (event.key === 'e') finish();
      else if (event.key === 'r') { event.preventDefault(); reply(); }
      else if (event.key === 'Escape') endReview();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!review) return null;
  const mark = current ? sessionMark(current, turns[current.id]) : null;
  return (
    <div ref={barRef} className="flex-shrink-0 border-b border-border bg-muted/40 px-2 py-1.5">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="mr-auto min-w-0 truncate text-xs text-foreground">
          <span className="font-medium">{current ? sessionDisplayName(current) : 'Review'}</span>
          <span className="pl-1.5 text-muted-foreground">{review.index + 1} of {review.queue.length}</span>
        </span>
        <button type="button" className={BUTTON} disabled={review.index === 0} onClick={() => move(-1)} aria-label="Previous">
          <ChevronLeft className="h-3.5 w-3.5" /> <KeyHint>K</KeyHint>
        </button>
        <button type="button" className={BUTTON} disabled={review.index >= review.queue.length - 1} onClick={() => move(1)} aria-label="Next">
          <KeyHint>J</KeyHint> <ChevronRight className="h-3.5 w-3.5" />
        </button>
        <button type="button" className={BUTTON} onClick={reply}>
          <MessageSquareReply className="h-3.5 w-3.5" /> Reply <KeyHint>R</KeyHint>
        </button>
        <button type="button" className={`${BUTTON} font-medium`} onClick={finish}>
          {pinned ? <Check className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          {pinned ? 'Clear' : 'Archive'} &amp; next <KeyHint>E</KeyHint>
        </button>
        <button type="button" className={BUTTON} onClick={endReview} aria-label="End review">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {current && mark && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={current.attention?.reason ?? undefined}>
          {MARK_WORD[mark]}{current.attention?.reason ? `: ${current.attention.reason}` : ''}
        </p>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
