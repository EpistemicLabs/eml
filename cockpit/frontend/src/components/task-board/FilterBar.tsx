// The Owner (Me · Everyone) and Space (All · each space) picks above Now and Plan.
import type { Board, TaskFilter } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';

const SEGMENT = cn('min-h-(--target-min) px-2.5 text-ui text-muted-foreground aria-pressed:bg-foreground aria-pressed:text-background', FOCUS);

export function FilterBar({ filter, spaces, onChange }: { filter: TaskFilter; spaces: Board['spaces']; onChange: (patch: Partial<TaskFilter>) => void }) {
  const segment = (label: string, pressed: boolean, patch: Partial<TaskFilter>) => (
    <button key={label} type="button" aria-pressed={pressed} onClick={() => onChange(patch)} className={SEGMENT}>{label}</button>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-ui text-muted-foreground">
      <span role="group" aria-label="Owner" className="flex items-center gap-2">Owner
        <span className="inline-flex overflow-hidden rounded-lg border border-border bg-card">
          {segment('Me', !filter.everyone, { everyone: false })}
          {segment('Everyone', filter.everyone, { everyone: true })}
        </span>
      </span>
      <span role="group" aria-label="Space" className="flex items-center gap-2">Space
        <span className="inline-flex flex-wrap overflow-hidden rounded-lg border border-border bg-card">
          {segment('All', !filter.spaceId, { spaceId: null })}
          {spaces.map((s) => segment(s.name, filter.spaceId === s.id, { spaceId: s.id }))}
        </span>
      </span>
    </div>
  );
}
