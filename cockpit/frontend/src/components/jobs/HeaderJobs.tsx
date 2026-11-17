// The header's right side: the Tasks and Jobs views' buttons. What a job's run needs from
// the user shows in the review section, on the run's session (Needs you, Check this).
import { CalendarClock, ListChecks } from 'lucide-react';

import { cn } from '@/lib/utils';
import { setTopView, useTopView } from '@/stores/useTopViewStore';

export default function HeaderJobs() {
  const topView = useTopView();
  const tab = (active: boolean) => cn(
    'flex h-8 items-center gap-1.5 rounded-md px-2 text-body transition-colors',
    active ? 'space-tab-active text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
  );
  return (
    <div className="flex flex-shrink-0 items-center gap-1 pr-3">
      <button
        type="button"
        onClick={() => setTopView(topView === 'tasks' ? 'desks' : 'tasks')}
        aria-pressed={topView === 'tasks'}
        title="Tasks: every open task, your turn first"
        className={tab(topView === 'tasks')}
      >
        <ListChecks className="h-4 w-4" />
        Tasks
      </button>
      <button
        type="button"
        onClick={() => setTopView(topView === 'jobs' ? 'desks' : 'jobs')}
        aria-pressed={topView === 'jobs'}
        title="Jobs: scheduled work"
        className={tab(topView === 'jobs')}
      >
        <CalendarClock className="h-4 w-4" />
        Jobs
      </button>
    </div>
  );
}
