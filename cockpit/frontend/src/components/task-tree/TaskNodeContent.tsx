// The content of a task row in every task tree (the tasks card, a task's Related block): its state dot,
// its title and an optional caption at the end. One place, so a change to how a task row reads applies
// everywhere a tree shows tasks.
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Dot, type TreeLine } from '@/shared/view/ui';
import type { NodeState } from '@/components/tasks-card/taskTree';

/** How a task hangs from the row above it: a sub-task by a solid line, a spun-off task by a dashed one. */
export function lineOf(rel: 'sub' | 'spun' | null | undefined): TreeLine | undefined {
  return rel === 'spun' ? 'dashed' : rel === 'sub' ? 'solid' : undefined;
}

/** The words for that line, for a caption or a screen reader. */
export function relWord(rel: 'sub' | 'spun' | null | undefined): string {
  return rel === 'spun' ? 'spun off' : rel === 'sub' ? 'sub-task' : '';
}

export function TaskNodeContent({ state, title, muted = false, aside, titleData }: {
  state: NodeState;
  title: ReactNode;
  /** The title in the muted colour (not on the desk, or done); the row's name says why. */
  muted?: boolean;
  /** A short caption at the end of the row: another project, or how it relates. */
  aside?: ReactNode;
  /** Marks the title element (tests and styles find it by this attribute). */
  titleData?: Record<`data-${string}`, string | boolean>;
}) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <Dot hue={state.hue} hollow={state.hollow} />
      <span {...titleData} className={cn('min-w-0 flex-1 truncate font-medium', muted ? 'text-muted-foreground' : 'text-foreground')}>{title}</span>
      {aside && <span className="flex-shrink-0 truncate text-caption font-normal text-muted-foreground">{aside}</span>}
    </span>
  );
}

/** The legend for those lines, next to a tree's heading. */
export function TreeLegend() {
  return (
    <span aria-hidden className="flex items-center gap-2.5 text-caption text-muted-foreground">
      <span className="flex items-center gap-1"><span className="w-4 border-t border-border-strong" />sub-task</span>
      <span className="flex items-center gap-1"><span className="w-4 border-t border-dashed border-border-strong" />spun off</span>
    </span>
  );
}
