// Small pieces the task board's views share (tokens v2 only: components/task-board holds no literal values).
import { CornerUpLeft } from 'lucide-react';

import { agentName, cardTime, type BoardTask } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { FOCUS, LABEL } from '@/shared/view/ui';

/** The owner (a person) and the delegate (an agent): who answers for it, who works on it. */
export function Who({ task, viewer }: { task: Pick<BoardTask, 'owner' | 'delegate'>; viewer: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      {task.owner && (
        <span
          title={`Owner: ${task.owner === viewer ? 'you' : task.owner}`}
          className={cn('inline-grid size-5 place-items-center rounded-full text-caption font-bold', task.owner === viewer ? 'bg-foreground text-background' : 'bg-person-2 text-white')}
        >
          {task.owner.charAt(0).toUpperCase()}
        </span>
      )}
      {task.delegate && <AgentBadge handle={task.delegate} />}
    </span>
  );
}

export function AgentBadge({ handle }: { handle: string }) {
  return (
    <span title={`Delegated to ${agentName(handle)}`} className="inline-flex h-5 items-center gap-1 rounded-full bg-status-agent/12 pl-1 pr-2 text-caption font-semibold text-agent-ink">
      <span aria-hidden className="size-2 rounded-xs bg-status-agent" />
      {agentName(handle)}
    </span>
  );
}

export function CardTime({ task, now }: { task: BoardTask; now: number }) {
  const t = cardTime(task, now);
  if (!t) return null;
  return (
    <time title={t.future ? 'When the agent picks it up next' : 'When this happened'} className={cn('ml-auto shrink-0 whitespace-nowrap text-caption tabular-nums', t.future ? 'text-scheduled-ink' : 'text-muted-foreground')}>
      {t.label}
    </time>
  );
}

/** Where a task came from: "from <origin task>", as a button when it can be opened. The same task as the origin row of its Related tree. */
export function FromOrigin({ name, onOpen, className }: { name: string; onOpen?: () => void; className?: string }) {
  const body = (
    <>
      <CornerUpLeft aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 truncate">from {onOpen ? <span className="underline decoration-border-strong underline-offset-2">{name}</span> : name}</span>
    </>
  );
  const look = cn('flex min-w-0 items-center gap-1 text-caption text-muted-foreground', className);
  return onOpen
    ? <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(); }} title={`Came from: ${name}`} className={cn(look, 'min-h-(--target-min) text-left hover:text-foreground')}>{body}</button>
    : <span title={`Came from: ${name}`} className={look}>{body}</span>;
}

/** A fold's header in a list: what it holds, and Show / Hide. `name` names the button for a screen reader when several folds share a page. */
export function Fold({ label, hint, name, open, onToggle }: { label: string; hint?: string; name?: string; open: boolean; onToggle: () => void }) {
  return (
    <div className={cn(LABEL, 'flex items-center justify-between gap-x-3 border-t border-border bg-muted px-3 py-2')}>
      <span>{label}{hint && <span className="font-normal normal-case tracking-normal"> · {hint}</span>}</span>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-label={name ? `${open ? 'Hide' : 'Show'} ${name}` : undefined} className={cn('min-h-(--target-min) text-ui normal-case tracking-normal text-mark-ink underline underline-offset-2', FOCUS)}>
        {open ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}

/** What the grey unread dot says: answers nobody opened, nothing to do. */
export const unreadLabel = (n: number) => `${n} unread answer${n === 1 ? '' : 's'}, nothing to do`;

/** The Inbox's grey dot for unread answers: never a number, so the count stays what waits for you. */
export function UnreadDot({ count }: { count: number }) {
  return <span role="img" aria-label={unreadLabel(count)} title={unreadLabel(count)} className="size-1.5 shrink-0 rounded-full bg-muted-foreground" />;
}
