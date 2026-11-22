// The tasks card's model: for each project with a session open on the desk, the trees those sessions
// belong to. In a space with the task system on, a tree is tasks from the origin task down (a sub-task
// under its parent, a spun-off task under the task it came from) with each task's sessions; elsewhere
// it is the sessions themselves, each under the session that started it. Pure, so the rules (where a
// tree starts, what a filter hides, which rows stay because a desk session is in them) are tested
// without a browser.
import { hueOf, TURN_META, type Board, type BoardTask, type LineageTask } from '@/lib/task-board';
import type { Hue } from '@/shared/view/ui/hue';
import type { AllSession } from '@/components/sidebar/allSessions';

export type SessionView = 'chat' | 'terminal';

/** A pane of the desk that shows a session, in the desk's order. */
export interface DeskSession {
  sessionId: string;
  paneId: string;
  view: SessionView;
}

/** A cockpit project, to name a section and a task of another project. */
export interface ProjectName {
  spaceId: string;
  projectId: string;
  brainProjectId?: string | null;
  name: string;
}

/** How a row's dot shows its state: a hue, filled or hollow, and the words a screen reader says. */
export interface NodeState {
  hue: Hue;
  hollow: boolean;
  label: string;
}

export interface SessionLeaf {
  id: string;
  spaceId: string;
  projectId: string | null;
  title: string;
  view: SessionView;
  /** In a pane of this desk. */
  open: boolean;
  /** In the desk's active pane. */
  current: boolean;
}

export interface TreeNode {
  /** Unique within its section (a tree can show in two sections). */
  key: string;
  kind: 'task' | 'session';
  id: string;
  title: string;
  state: NodeState;
  /** How it hangs under its parent row: sub (solid line), spun off (dashed), or a root. */
  rel: 'sub' | 'spun' | null;
  /** The project's name when it is not the section's project. */
  otherProject: string | null;
  sessions: SessionLeaf[];
  children: TreeNode[];
}

export interface TreeSection {
  key: string;
  title: string;
  nodes: TreeNode[];
}

export interface TreeInput {
  board: Pick<Board, 'tasks' | 'lineage' | 'spaces' | 'projects'> | null;
  sessions: AllSession[];
  desk: DeskSession[];
  projects: ProjectName[];
  activeSessionId: string | null;
  /** Closed tasks stay in the tree. */
  showDone: boolean;
  /** Sessions not open on the desk are listed too. */
  allSessions: boolean;
  /** The view a session not on the desk opens in. */
  viewOf(sessionId: string): SessionView;
  /** A session's own state, for trees without tasks. */
  stateOfSession(session: AllSession): NodeState;
}

type TaskLike = Pick<BoardTask, 'id' | 'spaceId' | 'project' | 'title' | 'status' | 'parentId'> &
  Partial<Pick<BoardTask, 'turn' | 'group' | 'sessionIds' | 'originId'>>;

const OPEN_STATUSES = new Set(['planned', 'active']);
/** A tree deeper than this is a loop in the data, not a real tree. */
const MAX_DEPTH = 32;

/** A task's dot: its turn's hue (red when stuck), hollow while it waits on someone or something. */
export function taskState(task: TaskLike): NodeState {
  if (task.status === 'resolved') return { hue: 'done', hollow: false, label: 'Done' };
  if (task.status === 'invalidated') return { hue: 'done', hollow: false, label: 'Dropped' };
  // Review is the person's turn too: amber like Needs you, so a finished result never looks like work in progress.
  const hue = task.turn === 'review' ? 'you' : hueOf({ turn: task.turn ?? null, group: task.group, status: task.status });
  if (!task.turn) return task.status === 'planned' ? { hue: 'waiting', hollow: true, label: 'Parked' } : { hue, hollow: false, label: 'Active' };
  const hollow = task.turn === 'agent_scheduled' || task.turn === 'waiting_on_others';
  return { hue, hollow, label: TURN_META[task.turn].name };
}

const taskKey = (spaceId: string, id: string) => `${spaceId}/${id}`;

export function buildTaskTree(input: TreeInput): TreeSection[] {
  const { board, desk } = input;
  const taskSpaces = new Set((board?.spaces ?? []).filter((s) => s.taskSystem).map((s) => s.id));
  const deskIds = new Map(desk.map((d) => [d.sessionId, d]));
  const live = input.sessions.filter((s) => !s.archivedAt || deskIds.has(s.id));
  const sessionById = new Map(live.map((s) => [s.id, s]));

  const tasks = new Map<string, TaskLike>();
  for (const t of board?.tasks ?? []) tasks.set(taskKey(t.spaceId, t.id), t);
  for (const t of board?.lineage ?? []) if (!tasks.has(taskKey(t.spaceId, t.id))) tasks.set(taskKey(t.spaceId, t.id), fromLineage(t));

  const brainProjectName = (spaceId: string, project: string | null) => {
    if (!project) return 'No project';
    return board?.projects.find((p) => p.spaceId === spaceId && p.id === project)?.name
      ?? input.projects.find((p) => p.spaceId === spaceId && p.brainProjectId === project)?.name
      ?? project;
  };
  const cockpitProjectName = (spaceId: string, projectId: string | null) =>
    input.projects.find((p) => p.spaceId === spaceId && p.projectId === projectId)?.name ?? projectId ?? 'No project';

  const leaf = (s: AllSession): SessionLeaf => {
    const onDesk = deskIds.get(s.id);
    return {
      id: s.id,
      spaceId: s.spaceId,
      projectId: s.projectId ?? null,
      title: s.summary || 'Untitled session',
      view: onDesk?.view ?? input.viewOf(s.id),
      open: Boolean(onDesk),
      current: s.id === input.activeSessionId,
    };
  };

  // ---- task trees ----
  const sessionsOfTask = (t: TaskLike): AllSession[] => {
    const ids = new Set(t.sessionIds ?? []);
    for (const s of live) if (s.spaceId === t.spaceId && s.taskId === t.id) ids.add(s.id);
    return [...ids].map((id) => sessionById.get(id)).filter((s): s is AllSession => Boolean(s));
  };
  const childrenOf = (t: TaskLike): TaskLike[] =>
    [...tasks.values()].filter((k) => k.spaceId === t.spaceId && k.id !== t.id && (k.parentId === t.id || (!k.parentId && k.originId === t.id)));
  const deskInTask = new Map<string, boolean>();
  const holdsDeskSession = (t: TaskLike, depth = 0): boolean => {
    const key = taskKey(t.spaceId, t.id);
    const known = deskInTask.get(key);
    if (known !== undefined) return known;
    deskInTask.set(key, false);
    const found = sessionsOfTask(t).some((s) => deskIds.has(s.id))
      || (depth < MAX_DEPTH && childrenOf(t).some((k) => holdsDeskSession(k, depth + 1)));
    deskInTask.set(key, found);
    return found;
  };
  const rootOfTask = (t: TaskLike): TaskLike => {
    let node = t;
    const seen = new Set([taskKey(t.spaceId, t.id)]);
    for (let i = 0; i < MAX_DEPTH; i++) {
      const up = node.parentId ?? node.originId ?? null;
      const next = up ? tasks.get(taskKey(node.spaceId, up)) : undefined;
      if (!next || seen.has(taskKey(next.spaceId, next.id))) break;
      seen.add(taskKey(next.spaceId, next.id));
      node = next;
    }
    return node;
  };
  const taskNode = (t: TaskLike, section: string, project: string | null, path: Set<string>): TreeNode => {
    const key = taskKey(t.spaceId, t.id);
    const nextPath = new Set(path).add(key);
    const kids = path.size < MAX_DEPTH
      ? childrenOf(t).filter((k) => !nextPath.has(taskKey(k.spaceId, k.id))
        // Only the desk's sessions: a branch stays only when a session open on the desk is in it.
        && (input.allSessions ? OPEN_STATUSES.has(k.status) || input.showDone || holdsDeskSession(k) : holdsDeskSession(k)))
      : [];
    const sessions = sessionsOfTask(t).filter((s) => input.allSessions || deskIds.has(s.id)).map(leaf);
    return {
      key: `${section}:${key}`,
      kind: 'task',
      id: t.id,
      title: t.title,
      state: taskState(t),
      rel: t.parentId ? 'sub' : t.originId ? 'spun' : null,
      otherProject: t.project !== project ? brainProjectName(t.spaceId, t.project) : null,
      sessions,
      children: kids.map((k) => taskNode(k, section, project, nextPath)),
    };
  };

  // ---- session trees (no task system, or a session without a task) ----
  const sessionChildren = (s: AllSession) => live.filter((k) => k.parentSessionId === s.id && k.id !== s.id);
  const deskInSession = new Map<string, boolean>();
  const sessionHoldsDesk = (s: AllSession, depth = 0): boolean => {
    const known = deskInSession.get(s.id);
    if (known !== undefined) return known;
    deskInSession.set(s.id, false);
    const found = deskIds.has(s.id) || (depth < MAX_DEPTH && sessionChildren(s).some((k) => sessionHoldsDesk(k, depth + 1)));
    deskInSession.set(s.id, found);
    return found;
  };
  const rootOfSession = (s: AllSession): AllSession => {
    let node = s;
    const seen = new Set([s.id]);
    for (let i = 0; i < MAX_DEPTH; i++) {
      const parent = node.parentSessionId ? sessionById.get(node.parentSessionId) : undefined;
      if (!parent || seen.has(parent.id)) break;
      seen.add(parent.id);
      node = parent;
    }
    return node;
  };
  const sessionNode = (s: AllSession, section: string, projectId: string | null, path: Set<string>, isChild: boolean): TreeNode => {
    const nextPath = new Set(path).add(s.id);
    const kids = path.size < MAX_DEPTH
      ? sessionChildren(s).filter((k) => !nextPath.has(k.id) && (input.allSessions || sessionHoldsDesk(k)))
      : [];
    const own = s.projectId ?? null;
    return {
      key: `${section}:${s.id}`,
      kind: 'session',
      id: s.id,
      title: s.summary || 'Untitled session',
      state: input.stateOfSession(s),
      rel: isChild ? 'sub' : null,
      otherProject: own !== projectId ? cockpitProjectName(s.spaceId, own) : null,
      sessions: [leaf(s)],
      children: kids.map((k) => sessionNode(k, section, projectId, nextPath, true)),
    };
  };

  // ---- sections, in the desk's order ----
  const sections = new Map<string, { title: string; roots: Map<string, () => TreeNode> }>();
  const sectionFor = (key: string, title: string) => {
    if (!sections.has(key)) sections.set(key, { title, roots: new Map() });
    return sections.get(key)!;
  };
  for (const d of desk) {
    const s = sessionById.get(d.sessionId);
    if (!s) continue;
    const hasTask = Boolean(s.taskId && taskSpaces.has(s.spaceId));
    const task = hasTask ? tasks.get(taskKey(s.spaceId, s.taskId!)) : undefined;
    // Its task is not on the board yet (just made): it shows once the board has it, never as a bare session meanwhile.
    if (hasTask && !task) continue;
    if (task) {
      const key = `t:${task.spaceId}/${task.project ?? ''}`;
      const section = sectionFor(key, brainProjectName(task.spaceId, task.project));
      const root = rootOfTask(task);
      const rootKey = taskKey(root.spaceId, root.id);
      if (!section.roots.has(rootKey)) section.roots.set(rootKey, () => taskNode(root, key, task.project, new Set()));
    } else {
      const projectId = s.projectId ?? null;
      const key = `s:${s.spaceId}/${projectId ?? ''}`;
      const section = sectionFor(key, cockpitProjectName(s.spaceId, projectId));
      const root = rootOfSession(s);
      if (!section.roots.has(root.id)) section.roots.set(root.id, () => sessionNode(root, key, projectId, new Set(), false));
    }
  }
  return [...sections.entries()].map(([key, { title, roots }]) => ({ key, title, nodes: [...roots.values()].map((make) => make()) }));
}

function fromLineage(t: LineageTask): TaskLike {
  return { id: t.id, spaceId: t.spaceId, project: t.project, title: t.title, status: t.status, parentId: t.parentId, originId: t.originId };
}
