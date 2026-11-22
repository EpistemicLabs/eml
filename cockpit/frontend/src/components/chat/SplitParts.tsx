// The chat's parts of splitting a topic off: the hover action on a message, and the marker that says
// where a topic left the chat, with the way to it and Undo.
import { Split } from 'lucide-react';

import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';

import { TARGET } from './tool-icons';

/** What a split left in the chat: where it happened and what came of it. */
export interface SplitMark {
  opId: string;
  title: string;
  /** The message it was split from; null: the end of the chat at the time. */
  afterItemId: string | null;
  sessionId?: string;
  parked: boolean;
  undoUntil: string;
  undone?: boolean;
}

/** "Split from here" on a message: shows on hover and when the keyboard reaches it. */
export function MessageActions({ onSplit }: { onSplit: () => void }) {
  return (
    <div className="pointer-events-none absolute -top-3 right-1 z-(--z-raised) opacity-0 transition-opacity duration-(--duration-fast) group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <button
        type="button"
        onClick={onSplit}
        className={cn('inline-flex items-center gap-1 rounded-full border border-border bg-card px-2.5 text-caption text-foreground shadow-card hover:bg-muted', TARGET, FOCUS)}
      >
        <Split aria-hidden className="size-3" />
        Split from here
      </button>
    </div>
  );
}

/** Where a topic left the chat: a rule with the new task's name, how to get to it, and Undo while it may. */
export function SplitMarker({ mark, now, onOpen, onUndo }: { mark: SplitMark; now: number; onOpen: () => void; onUndo: () => void }) {
  const canUndo = !mark.undone && Date.parse(mark.undoUntil) > now;
  return (
    <div role="note" className="flex items-center gap-2 text-caption text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      <Split aria-hidden className="size-3 flex-shrink-0" />
      {mark.undone ? (
        <span>Split of {mark.title} undone</span>
      ) : (
        <>
          <span>Split off</span>
          {mark.sessionId
            ? <button type="button" onClick={onOpen} className={cn('font-semibold text-foreground underline underline-offset-2', TARGET, FOCUS)}>{mark.title}</button>
            : <b className="font-semibold text-foreground">{mark.title}</b>}
          <span>{mark.parked ? '· parked in Plan' : ''}</span>
          {canUndo && <button type="button" onClick={onUndo} className={cn('text-foreground underline underline-offset-2', TARGET, FOCUS)}>Undo</button>}
        </>
      )}
    </div>
  );
}
