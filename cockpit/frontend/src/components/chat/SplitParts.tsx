// The chat's parts of splitting a topic off: the hover action on a message, and the marker that says
// where a topic left the chat, with the way to it and Undo.
import { ListPlus, ListTree, Split } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BUTTON, FOCUS, PRIMARY, Tooltip } from '@/shared/view/ui';

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

/**
 * The action row under a message: a split icon (with a tooltip) that shows while that message is hovered or
 * the keyboard is on it (a named group, so a hovered pane does not show it everywhere). Its height is kept
 * even while hidden, so the text below never jumps when it appears.
 */
export function MessageActions({ onSplit }: { onSplit: () => void }) {
  return (
    <div className="pointer-events-none flex h-(--target-min) items-center gap-1 opacity-0 transition-opacity duration-(--duration-fast) group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <Tooltip content="Split from here" position="bottom">
        <button
          type="button"
          onClick={onSplit}
          aria-label="Split from here"
          className={cn('flex size-(--target-min) items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)}
        >
          <Split aria-hidden className="size-3.5" />
        </button>
      </Tooltip>
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

/** The agent's offer to split a topic off: the choice stays until the user makes it. */
export function OfferCard({ title, reason, decided, onSplit, onKeep }: { title: string; reason: string; decided: 'split' | 'kept' | null; onSplit: () => void; onKeep: () => void }) {
  return (
    <div className="flex max-w-(--size-chat-bubble) flex-col gap-2 rounded-xl border border-border px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-label text-muted-foreground">
        <Split aria-hidden className="size-3" />
        New topic
      </span>
      <p className="m-0"><b>{title}</b>{reason ? ` · ${reason}` : ''}</p>
      {decided ? (
        <span className="text-ui text-muted-foreground">{decided === 'split' ? 'Split off.' : 'Kept here.'}</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={onSplit} className={cn(PRIMARY, 'inline-flex items-center gap-1.5')}><Split aria-hidden className="size-3" />Split off…</button>
          <button type="button" onClick={onKeep} className={BUTTON}>Keep it here</button>
        </div>
      )}
    </div>
  );
}

/** The agent's proposal to sort a drifted session: the choice stays until the user makes it. */
export function SortCard({ topics, reason, result, onSort, onLater }: { topics: number; reason: string; result: string | null; onSort: () => void; onLater: () => void }) {
  return (
    <div className="flex max-w-(--size-chat-bubble) flex-col gap-2 rounded-xl border border-border px-3 py-2.5">
      <span className="flex items-center gap-1.5 text-caption font-semibold uppercase tracking-label text-muted-foreground">
        <ListTree aria-hidden className="size-3" />
        This session moved on
      </span>
      <p className="m-0">{topics} topics{reason ? `: ${reason}` : ''}. Sort them so each one lands where it belongs?</p>
      {result ? (
        <span className="text-ui text-muted-foreground">{result}</span>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={onSort} className={PRIMARY}>Sort topics…</button>
          <button type="button" onClick={onLater} className={BUTTON}>Later</button>
        </div>
      )}
    </div>
  );
}

/** A task the agent created: a bar like a split's, with Undo while the task is open. */
export function CreatedMarker({ title, state, onUndo }: { title: string; state: 'open' | 'undoing' | 'undone' | 'unknown' | { error: string }; onUndo: () => void }) {
  return (
    <div role="note" className="flex flex-wrap items-center justify-center gap-2 text-caption text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">
      <ListPlus aria-hidden className="size-3 flex-shrink-0" />
      {state === 'undone' ? (
        <span>Task {title} dropped</span>
      ) : (
        <>
          <span>New task</span>
          <b className="font-semibold text-foreground">{title}</b>
          <span>· in Plan</span>
          {state === 'open' && <button type="button" onClick={onUndo} className={cn('text-foreground underline underline-offset-2', TARGET, FOCUS)}>Undo</button>}
          {typeof state === 'object' && <span role="alert" className="text-stopped-ink">{state.error}</span>}
        </>
      )}
    </div>
  );
}
