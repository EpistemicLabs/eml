// Small pieces the task board's views share (tokens v2 only: components/task-board holds no literal values).
import { agentName, cardTime, type BoardTask } from '@/lib/task-board';
import { cn } from '@/lib/utils';

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
