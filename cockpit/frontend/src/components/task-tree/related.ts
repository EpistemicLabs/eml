// A task's Related block: where it came from (its parent, or the task it was spun off from, and further up)
// and what came out of it (its sub-tasks and the tasks spun off from it). Pure, so the rules are tested
// without a browser. Same links as the tasks card's trees (taskTree.ts): parentId first, else originId.
import { OPEN_STATUSES, type Board, type BoardTask } from '@/lib/task-board';
import { taskState, type NodeState, type TaskLike } from '@/components/tasks-card/taskTree';

export interface RelatedTask {
  id: string;
  title: string;
  state: NodeState;
  /** How it hangs from the row above it. */
  rel: 'sub' | 'spun' | null;
  /** The board's task, to open in the task view; missing for a closed ancestor (only its engram opens). */
  task?: BoardTask;
}

export interface Related {
  /** Top first; the last one is the task this one came from. */
  origins: RelatedTask[];
  /** How this task hangs from the last origin. */
  rel: 'sub' | 'spun' | null;
  /** Open children, the person's turn first, then the agent's, then the rest. */
  open: RelatedTask[];
  done: RelatedTask[];
}

/** A chain longer than this is a loop in the data. */
const MAX_DEPTH = 32;

const relOf = (t: Pick<TaskLike, 'parentId' | 'originId'>): 'sub' | 'spun' | null => (t.parentId ? 'sub' : t.originId ? 'spun' : null);

const ORDER: Record<string, number> = { you: 0, stopped: 0, agent: 1 };

/** Null when the task has no origin and no children. */
export function relatedOf(task: TaskLike, board: Pick<Board, 'tasks' | 'lineage'>): Related | null {
  const all = new Map<string, { like: TaskLike; task?: BoardTask }>();
  for (const t of board.lineage ?? []) if (t.spaceId === task.spaceId) all.set(t.id, { like: { ...t } });
  for (const t of board.tasks) if (t.spaceId === task.spaceId) all.set(t.id, { like: t, task: t });
  const item = (like: TaskLike, task?: BoardTask): RelatedTask => ({ id: like.id, title: like.title, state: taskState(like), rel: relOf(like), ...(task ? { task } : {}) });

  const origins: RelatedTask[] = [];
  const seen = new Set([task.id]);
  let node: TaskLike = task;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const up = node.parentId ?? node.originId ?? null;
    const next = up ? all.get(up) : undefined;
    if (!next || seen.has(next.like.id)) break;
    seen.add(next.like.id);
    origins.unshift(item(next.like, next.task));
    node = next.like;
  }

  const children = [...all.values()]
    .filter(({ like }) => like.id !== task.id && (like.parentId === task.id || (!like.parentId && like.originId === task.id)))
    .map(({ like, task: t }) => ({ open: OPEN_STATUSES.has(like.status), row: item(like, t) }));
  const open = children.filter((c) => c.open).map((c) => c.row)
    .sort((a, b) => (ORDER[a.state.hue] ?? 2) - (ORDER[b.state.hue] ?? 2));
  const done = children.filter((c) => !c.open).map((c) => c.row);

  if (origins.length === 0 && open.length === 0 && done.length === 0) return null;
  return { origins, rel: relOf(task), open, done };
}
