// The header's right side: the Jobs view's button. What a job's run needs from
// the user shows in the review section, on the run's session (Needs you, Check this).
import { CalendarClock } from 'lucide-react';

import { cn } from '@/lib/utils';
import { setTopView, useTopView } from '@/stores/useTopViewStore';

export default function HeaderJobs() {
  const topView = useTopView();
  return (
    <div className="flex flex-shrink-0 items-center pr-3">
      <button
        type="button"
        onClick={() => setTopView(topView === 'jobs' ? 'desks' : 'jobs')}
        aria-pressed={topView === 'jobs'}
        title="Jobs: scheduled work"
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md px-2 text-body transition-colors',
          topView === 'jobs' ? 'space-tab-active text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
        )}
      >
        <CalendarClock className="h-4 w-4" />
        Jobs
      </button>
    </div>
  );
}
