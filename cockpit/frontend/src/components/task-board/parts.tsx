// Small pieces the task board's views share (tokens v2 only: components/task-board holds no literal values).
import type { ReactNode } from 'react';

import { agentName, cardTime, HUE, type BoardTask, type Hue } from '@/lib/task-board';
import { cn } from '@/lib/utils';

export const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring';
export const LABEL = 'text-caption font-semibold uppercase tracking-label text-muted-foreground';
export const BUTTON = cn('inline-flex min-h-(--target-comfortable) items-center justify-center gap-2 rounded-full border border-border bg-card px-4 text-body font-medium text-foreground hover:bg-muted disabled:opacity-60', FOCUS);
export const PRIMARY = cn(BUTTON, 'border-primary bg-primary text-primary-foreground hover:bg-primary hover:opacity-90');
export const MINI = cn('inline-flex min-h-(--target-min) items-center rounded-md border border-border bg-card px-2 text-ui text-muted-foreground hover:bg-background hover:text-foreground', FOCUS);

export function Chip({ hue, children, className }: { hue?: Hue; children: ReactNode; className?: string }) {
  const h = HUE[hue ?? 'done'];
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 text-caption font-medium', hue ? cn(h.chip, h.ink) : 'bg-muted text-muted-foreground', className)}>
      {children}
    </span>
  );
}

export function Dot({ hue, live = false }: { hue: Hue; live?: boolean }) {
  return <span aria-hidden className={cn('inline-block size-2 shrink-0 rounded-full', HUE[hue].dot, live && cn('animate-live', HUE[hue].ink))} />;
}

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

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-xl border border-dashed border-border p-3 text-ui text-muted-foreground">{children}</div>;
}
