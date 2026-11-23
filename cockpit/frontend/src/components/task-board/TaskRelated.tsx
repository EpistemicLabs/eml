// The Related block of an opened task, under its project line: where it came from and what came out of it,
// as a tree drawn like the tasks card's (solid line = sub-task, dashed = spun off). Compact: only the task
// it came from (higher ones behind "n more up") and the open children (done ones behind "n done").
// Every row opens that task here; the task you came from is always in the new task's tree, so it is the way back.
import { useMemo, useState, type ReactElement } from 'react';

import { type Board, type BoardTask } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { FOCUS, LABEL, Tree, TreeItem } from '@/shared/view/ui';
import { lineOf, relWord, TaskNodeContent, TreeLegend } from '@/components/task-tree/TaskNodeContent';
import { relatedOf, type RelatedTask } from '@/components/task-tree/related';
import { taskState } from '@/components/tasks-card/taskTree';

export const RELATED_LABEL_ID = 'task-related-label';

export function TaskRelated({ task, board, onOpen }: { task: BoardTask; board: Pick<Board, 'tasks' | 'lineage'>; onOpen: (item: RelatedTask) => void }) {
  const related = useMemo(() => relatedOf(task, board), [task, board]);
  const [allUp, setAllUp] = useState(false);
  const [showDone, setShowDone] = useState(false);

  if (!related) {
    return (
      <section aria-labelledby={RELATED_LABEL_ID} className="flex flex-col gap-1">
        <h3 id={RELATED_LABEL_ID} className={LABEL}>Related</h3>
        <p className="m-0 flex min-h-(--target-comfortable) items-center rounded-lg border border-dashed border-border px-2 py-1 text-ui text-muted-foreground">
          No parent, sub-tasks or spun-off tasks. Split one off from the chat.
        </p>
      </section>
    );
  }

  const { origins, open, done } = related;
  const shown = allUp ? origins : origins.slice(-1);
  const hidden = origins.length - shown.length;
  const row = (item: RelatedTask, aside: string, muted = false) => (
    <TreeItem
      key={item.id}
      line={lineOf(item.rel)}
      label={`${item.title}, ${item.state.label}${aside ? `, ${aside}` : ''}`}
      onSelect={() => onOpen(item)}
      content={<TaskNodeContent state={item.state} title={item.title} muted={muted} aside={aside} />}
    />
  );

  const children = [...open.map((k) => row(k, relWord(k.rel))), ...(showDone ? done.map((k) => row(k, relWord(k.rel), true)) : [])];
  if (done.length > 0) {
    const words = showDone ? 'Hide done' : `${done.length} done · show all ${open.length + done.length}`;
    children.push(
      <TreeItem key="done" line="solid" label={words} onSelect={() => setShowDone((v) => !v)}
        content={<span className="min-w-0 flex-1 truncate text-caption text-muted-foreground">{words}</span>} />,
    );
  }
  const selfRel = shown.length > 0 ? related.rel : null;
  let tree: ReactElement = (
    <TreeItem
      key="self"
      line={lineOf(selfRel)}
      label={`This task, ${taskState(task).label}${selfRel ? `, ${relWord(selfRel)}` : ''}`}
      selected
      expanded={children.length > 0 ? true : undefined}
      foldable={false}
      content={<TaskNodeContent state={taskState(task)} title="This task" aside={relWord(selfRel)} />}
    >
      {children}
    </TreeItem>
  );
  // Each origin holds the next one down; the last holds this task.
  for (let i = shown.length - 1; i >= 0; i--) {
    const o = shown[i];
    const direct = i === shown.length - 1;
    tree = (
      <TreeItem
        key={o.id}
        line={i > 0 ? lineOf(o.rel) : undefined}
        label={`${o.title}, ${o.state.label}${direct ? `, ${related.rel === 'sub' ? 'parent' : 'origin'}` : ''}`}
        onSelect={() => onOpen(o)}
        expanded
        foldable={false}
        content={<TaskNodeContent state={o.state} title={o.title} muted={o.state.hue === 'done'} aside={direct ? (related.rel === 'sub' ? 'parent' : 'origin') : undefined} />}
      >
        {tree}
      </TreeItem>
    );
  }

  return (
    <section aria-labelledby={RELATED_LABEL_ID} className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <h3 id={RELATED_LABEL_ID} className={LABEL}>Related</h3>
        <TreeLegend />
      </div>
      {hidden > 0 && (
        <button type="button" onClick={() => setAllUp(true)} className={cn('min-h-(--target-min) self-start rounded-md px-1 text-caption text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)}>
          ↑ {hidden} more up
        </button>
      )}
      <Tree label="Related tasks">{tree}</Tree>
    </section>
  );
}
