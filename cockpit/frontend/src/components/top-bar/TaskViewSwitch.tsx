// The bar's right end: Inbox · Now · Plan as one tab switch. A tab shows as picked only while
// the task view is open; the Inbox tab carries how many items wait for the viewer.
import { FOCUS } from '@/shared/view/ui';
import { useTaskBoard } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { useTaskView, type TaskView } from '@/stores/useTaskViewStore';
import { useTopView } from '@/stores/useTopViewStore';

import { openTaskView } from './useCockpitShortcuts';

const VIEWS: Array<[TaskView, string, string]> = [['inbox', 'Inbox', 'I'], ['now', 'Now', 'N'], ['plan', 'Plan', 'P']];

export const TAB = cn('flex h-(--size-tab) items-center gap-1.5 whitespace-nowrap rounded-(--radius-tab) px-3 text-body font-medium text-muted-foreground hover:text-foreground aria-selected:bg-card aria-selected:text-foreground aria-selected:shadow-(--shadow-pill)', FOCUS);
/** The track around the space you are in and around the open task view. */
export const TRACK = 'flex items-center gap-0.5 rounded-(--radius-track) p-(--pad-track)';

/** A count next to a tab's name: grey, or red for something that stopped with an error. */
export function Count({ children, label, stopped = false }: { children: React.ReactNode; label: string; stopped?: boolean }) {
  return (
    <span title={label} aria-label={label}
      className={cn('inline-grid h-4 min-w-4 place-items-center rounded-full px-1 text-caption font-bold leading-none tabular-nums',
        stopped ? 'bg-status-stopped/12 text-stopped-ink' : 'bg-foreground/12 text-foreground')}>
      {children}
    </span>
  );
}

export function TaskViewSwitch() {
  const topView = useTopView();
  const { view } = useTaskView();
  const inbox = useTaskBoard().data?.counts.inbox ?? 0;
  return (
    // Like a space's group of desks: plain until a task view is open, then the light background.
    <div role="tablist" aria-label="Task views" className={cn(TRACK, 'flex-shrink-0', topView === 'tasks' && 'bg-foreground/8')}>
      {VIEWS.map(([v, label, key]) => (
        <button key={v} type="button" role="tab" aria-selected={topView === 'tasks' && view === v} title={`${label} (G then ${key})`}
          onClick={() => openTaskView(v)} className={TAB}>
          {label}
          {v === 'inbox' && inbox > 0 && <Count label={`${inbox} waiting for you`}>{inbox}</Count>}
        </button>
      ))}
    </div>
  );
}
