import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Archive, Check, ChevronLeft, ChevronRight, MessageSquareReply, Send, X } from 'lucide-react';

import { MARK_WORD, sessionMark, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { sessionDisplayName } from '@/components/sidebar/utils';
import { answerCurrent, endReview, finishCurrent, liveQueue, stepReview } from '@/lib/review-flow';
import { useReview } from '@/stores/useReviewStore';
import { useSpaces } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';

const BUTTON =
  'flex h-8 min-w-8 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-40';

// Dimmed while the bar doesn't hold the keyboard: then the keys go elsewhere.
function KeyHint({ children }: { children: string }) {
  return (
    <kbd className="hidden rounded border border-border px-1 text-[10px] text-muted-foreground opacity-40 group-focus-within:opacity-100 md:inline">
      {children}
    </kbd>
  );
}

/** Keys only while nothing is being typed: the answer box keeps its own. */
const isTyping = (target: EventTarget | null): boolean => {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.('input, textarea, select, [contenteditable="true"], .xterm'));
};

/**
 * The review flow's bar on top of its pane: where it is in the queue, and what
 * the session asks for. The bar holds the keyboard: after every step the focus
 * is on it, and its pane's terminal or chat input takes it only on R or a click.
 * D goes on (right), A goes back (left), E takes the session out (on a question it goes to the answer
 * box), R goes to the reply box, Esc ends the flow (in the answer box it only
 * comes back to the bar). The keys act only here, never on another desk. A
 * phone gets the same buttons, and no keyboard opens on its own.
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
  const [draft, setDraft] = useState('');
  const barRef = useRef<HTMLDivElement>(null);
  const answerRef = useRef<HTMLInputElement>(null);

  const known = useMemo<AllSession[]>(() => sessions ?? [], [sessions]);
  const current = known.find((session) => session.id === review?.queue[review.index]);
  const pinned = Boolean(current?.isPinned);
  const mark = current ? sessionMark(current, turns[current.id]) : null;
  // A check is settled by Done; what else stays gets taken out, and a pinned session keeps its place.
  const settles = mark === 'review' || pinned;
  const action: 'archive' | 'clear' = settles ? 'clear' : 'archive';

  const move = (step: 1 | -1) => stepReview(step, known, spaces);
  const isQuestion = current?.attention?.kind === 'question';
  const finish = (how: 'archive' | 'clear' = action) => {
    if (!current) return;
    setError(null);
    void finishCurrent(how, known, spaces).then(setError);
  };
  const answer = () => {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    void answerCurrent(text, known, spaces).then((problem) => {
      setError(problem);
      if (!problem) setDraft('');
    });
  };
  // Each session starts clean, with the keyboard on the bar: a key never lands in an input by itself.
  const currentId = review?.queue[review.index];
  useEffect(() => {
    setDraft('');
    setError(null);
    barRef.current?.focus({ preventScroll: true });
  }, [currentId]);
  const reply = () => {
    if (isQuestion) { answerRef.current?.focus(); return; }
    const pane = barRef.current?.parentElement;
    pane?.querySelector<HTMLTextAreaElement>('textarea')?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
    const keys: Record<string, () => void> = {
      d: () => move(1),
      a: () => move(-1),
      e: () => (isQuestion ? reply() : finish()),
      r: reply,
      Escape: endReview,
    };
    const run = keys[event.key];
    if (!run) return;
    // Handled here and nowhere else: Escape must not also stop the session in the pane.
    event.preventDefault();
    event.stopPropagation();
    run();
  };

  if (!review) return null;
  const live = liveQueue(review, known);
  // Opened, a result without a request has left the list: the bar keeps saying what it was.
  const word = mark ? MARK_WORD[mark] : current?.attention?.kind === 'done' ? MARK_WORD.result : null;
  return (
    <div
      ref={barRef}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      aria-label="Review"
      className="group flex-shrink-0 border-b border-border bg-muted/40 px-2 py-1.5 outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <span className="mr-auto min-w-0 truncate text-xs text-foreground">
          <span className="font-medium">{current ? sessionDisplayName(current) : 'Review'}</span>
          <span className="pl-1.5 text-muted-foreground">{live.index + 1} of {live.queue.length}</span>
        </span>
        <button type="button" className={BUTTON} disabled={live.index <= 0} onClick={() => move(-1)} aria-label="Previous">
          <ChevronLeft className="h-3.5 w-3.5" /> <KeyHint>A</KeyHint>
        </button>
        <button type="button" className={BUTTON} disabled={live.index >= live.queue.length - 1} onClick={() => move(1)} aria-label="Next">
          <KeyHint>D</KeyHint> <ChevronRight className="h-3.5 w-3.5" />
        </button>
        {isQuestion ? (
          <button type="button" className={BUTTON} onClick={() => finish()} aria-label={pinned ? 'Done without answering' : 'Archive without answering'} title={pinned ? 'Done without answering' : 'Archive without answering'}>
            {pinned ? <Check className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
          </button>
        ) : (
          <>
            <button type="button" className={BUTTON} onClick={reply}>
              <MessageSquareReply className="h-3.5 w-3.5" /> Reply <KeyHint>R</KeyHint>
            </button>
            {mark === 'review' && !pinned && (
              <button type="button" className={BUTTON} onClick={() => finish('archive')} aria-label="Archive" title="Archive">
                <Archive className="h-3.5 w-3.5" />
              </button>
            )}
            <button type="button" className={`${BUTTON} font-medium`} onClick={() => finish()}>
              {settles ? <Check className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />}
              {settles ? 'Done' : 'Archive'} &amp; next <KeyHint>E</KeyHint>
            </button>
          </>
        )}
        <button type="button" className={BUTTON} onClick={endReview} aria-label="End review">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      {current && word && (
        <p className="mt-1 truncate text-[11px] text-muted-foreground" title={current.attention?.reason ?? undefined}>
          {word}{current.attention?.reason ? `: ${current.attention.reason}` : ''}
        </p>
      )}
      {isQuestion && (
        <div className="mt-1 flex items-center gap-1.5">
          <input
            ref={answerRef}
            type="text"
            value={draft}
            enterKeyHint="send"
            aria-label="Your answer"
            placeholder="Your answer"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') answer();
              else if (event.key === 'Escape') barRef.current?.focus({ preventScroll: true });
            }}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none select-text focus:border-primary md:text-xs"
          />
          <KeyHint>R</KeyHint>
          <button type="button" className={`${BUTTON} font-medium`} disabled={!draft.trim()} onClick={answer}>
            <Send className="h-3.5 w-3.5" /> Answer &amp; next
          </button>
        </div>
      )}
      {error && <p role="alert" className="mt-1 text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
