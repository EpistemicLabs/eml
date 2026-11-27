// The tasks card's model: for each project with a session open on the desk, the trees those sessions
// belong to (with All tasks, every open tree of those projects; with Show done, also their closed trees and
// finished sessions, below the open work, newest first). A tree is tasks from the origin task down (a sub-task under its parent, a spun-off task
// under the task it came from) with each task's sessions; a session without a task is a tree of
// sessions, each under the session that started it. Pure, so the rules (where a
// tree starts, what a filter hides, which rows stay because a desk session is in them) are tested
// without a browser.
import { agentName, checkBackText, checkBackWho, hueOf, OPEN_STATUSES, taskName, TURN_META, when, type Board, type BoardTask, type LineageTask } from '@/lib/task-board';
import type { Hue } from '@/shared/view/ui/hue';
import type { AllSession } from '@/components/sidebar/allSessions';

/** A pane of the desk that shows a session, in the desk's order. */
export interface DeskSession {
  sessionId: string;
  paneId: string;
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

/**
 * A chip under a task's name: whose move it waits on ("Your move", "Review", "Waiting on Sam"), and a clock when the
 * task has a wake-up (who and when). The owner's move and the agent's check-back stand side by side. `words`: what a
 * screen reader says for it.
 */
export interface NodeChip {
  kind: 'wait' | 'clock';
  label: string;
  hue?: Hue;
  words: string;
}

export interface SessionLeaf {
  id: string;
  spaceId: string;
  projectId: string | null;
  title: string;
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
  /** A task's wait and wake-up chips; none on a session or a closed task. */
  chips?: NodeChip[];
}

export interface TreeSection {
  key: string;
  title: string;
  nodes: TreeNode[];
  /** A section of tasks: its space and brain project (for "more open tasks in …"); none for a session tree. */
  project?: { spaceId: string; id: string | null };
  /** Show done: older closed tasks or finished sessions are left out (the card's "Show older"). */
  doneMore?: boolean;
}

/** The closed tasks the card loaded for Show done (GET /api/v1/tasks/closed), newest first. */
export interface ClosedTasks {
  tasks: TaskLike[];
  /** `${spaceId}/${project}` of each project with older closed tasks left. */
  more: Set<string>;
}

export interface TreeInput {
  board: Pick<Board, 'tasks' | 'lineage' | 'projects'> | null;
  sessions: AllSession[];
  desk: DeskSession[];
  projects: ProjectName[];
  activeSessionId: string | null;
  /** Closed tasks stay in the tree, and the desk projects' closed trees and finished sessions show below the open ones. */
  showDone: boolean;
  /** The closed tasks of the desk's projects, loaded while Show done is on. */
  closed?: ClosedTasks;
  /** Show done: how many finished session trees without a task a section shows. */
  doneLimit?(sectionKey: string): number;
  /** Every open task of the desk's projects, with all their sessions; off, only what leads to a desk session. */
  allTasks: boolean;
  /** A session's own state, for trees without tasks. */
  stateOfSession(session: AllSession): NodeState;
  /** The board's viewer, whose move a wait can be, and the time the chips are said at. */
  viewer?: string;
  now?: number;
}

export type TaskLike = Pick<BoardTask, 'id' | 'spaceId' | 'project' | 'title' | 'status' | 'parentId'> &
  Partial<Pick<BoardTask, 'turn' | 'group' | 'sessionIds' | 'originId' | 'displayTitle' | 'waitingOn' | 'schedule' | 'owner'>>;

/** A tree deeper than this is a loop in the data, not a real tree. */
const MAX_DEPTH = 32;

/** A task's dot: its turn's hue (red when stuck), hollow while it waits on someone or something. */
export function taskState(task: TaskLike): NodeState {
  if (task.status === 'resolved') return { hue: 'done', hollow: false, label: 'Done' };
  if (task.status === 'invalidated') return { hue: 'done', hollow: false, label: 'Dropped' };
  if (task.status === 'superseded') return { hue: 'done', hollow: false, label: 'Replaced' };
  // Review is the person's turn too: amber like Needs you, so a finished result never looks like work in progress.
  const hue = task.turn === 'review' ? 'you' : hueOf({ turn: task.turn ?? null, group: task.group, status: task.status });
  if (!task.turn) return task.status === 'planned' ? { hue: 'waiting', hollow: true, label: 'Parked' } : { hue, hollow: false, label: 'Active' };
  const hollow = task.turn === 'agent_scheduled' || task.turn === 'waiting_on_others';
  return { hue, hollow, label: TURN_META[task.turn].name };
}

/**
 * A task's chips: what it waits on, then its wake-up. The viewer's move is named by kind (a step to take, a result to
 * review, a question); anyone else's as "Waiting on <who>". A stop shows in the dot, a parked wait not at all.
 */
export function taskChips(task: TaskLike, viewer: string | undefined, now: number): NodeChip[] {
  if (!OPEN_STATUSES.has(task.status)) return [];
  const chips: NodeChip[] = [];
  const w = task.waitingOn;
  if (w && task.turn !== 'parked' && w.kind !== 'stopped') {
    const mine = Boolean(viewer) && w.who === viewer;
    let label: string | null;
    if (w.kind === 'outside') label = w.who === task.owner || mine ? 'Waiting outside' : `Waiting on ${w.who}`;
    else if (!mine) label = `Waiting on ${agentName(w.who)}`;
    else label = w.kind === 'do' ? 'Your move' : w.kind === 'review' ? 'Review' : w.kind === 'go' ? 'Your go' : 'Question';
    if (label) chips.push({ kind: 'wait', label, words: label, ...(mine && w.kind !== 'outside' ? { hue: 'you' as const } : {}) });
  }
  const at = task.schedule?.at;
  if (at) {
    const by = task.schedule?.by;
    const who = by ? checkBackWho(by, viewer, { short: true }) : '';
    chips.push({ kind: 'clock', label: [who, when(at, now)].filter(Boolean).join(' · '), words: checkBackText({ at, by: by ?? null }, viewer, now) });
  }
  return chips;
}

const taskKey = (spaceId: string, id: string) => `${spaceId}/${id}`;

/** A finished session's dot: put away, so grey like a closed task. */
const FINISHED: NodeState = { hue: 'done', hollow: false, label: 'Finished' };

/** How many closed trees or finished session trees a section shows before "Show older". */
export const DONE_PAGE = 20;

/** The brain project of a cockpit project: what a session without a task belongs to on the brain side. */
const brainProjectOf = (projects: ProjectName[], spaceId: string, projectId: string | null): string | null =>
  projects.find((p) => p.spaceId === spaceId && p.projectId === projectId)?.brainProjectId ?? null;

/**
 * The brain projects the desk's sessions belong to, whose tasks the card shows: a session's task's project, or
 * for a session without a task its cockpit project's brain project. What the card loads closed tasks for.
 */
export function deskTaskProjects(input: Pick<TreeInput, 'board' | 'sessions' | 'desk' | 'projects'>): Array<{ spaceId: string; project: string }> {
  const found = new Map<string, { spaceId: string; project: string }>();
  const byId = new Map(input.sessions.map((s) => [s.id, s]));
  const known = [...(input.board?.tasks ?? []), ...(input.board?.lineage ?? [])];
  for (const d of input.desk) {
    const s = byId.get(d.sessionId);
    if (!s) continue;
    const project = s.taskId
      ? known.find((t) => t.spaceId === s.spaceId && t.id === s.taskId)?.project
      : brainProjectOf(input.projects, s.spaceId, s.projectId ?? null);
    if (project) found.set(`${s.spaceId}/${project}`, { spaceId: s.spaceId, project });
  }
  return [...found.values()];
}

export function buildTaskTree(input: TreeInput): TreeSection[] {
  const { board, desk } = input;
  const deskIds = new Map(desk.map((d) => [d.sessionId, d]));
  // Show done: finished (archived) sessions count too.
  const live = input.sessions.filter((s) => input.showDone || !s.archivedAt || deskIds.has(s.id));
  const sessionById = new Map(live.map((s) => [s.id, s]));

  const tasks = new Map<string, TaskLike>();
  for (const t of board?.tasks ?? []) tasks.set(taskKey(t.spaceId, t.id), t);
  for (const t of board?.lineage ?? []) if (!tasks.has(taskKey(t.spaceId, t.id))) tasks.set(taskKey(t.spaceId, t.id), fromLineage(t));
  const closedTasks = input.showDone ? input.closed?.tasks ?? [] : [];
  for (const t of closedTasks) if (!tasks.has(taskKey(t.spaceId, t.id))) tasks.set(taskKey(t.spaceId, t.id), t);

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
  const isClosedShown = (t: TaskLike) => input.showDone && !OPEN_STATUSES.has(t.status);
  /** Where a closed tree starts: its topmost closed task, stopping below an open one. */
  const closedRootOf = (t: TaskLike): TaskLike => {
    let node = t;
    const seen = new Set([taskKey(t.spaceId, t.id)]);
    for (let i = 0; i < MAX_DEPTH; i++) {
      const up = node.parentId ?? node.originId ?? null;
      const next = up ? tasks.get(taskKey(node.spaceId, up)) : undefined;
      if (!next || OPEN_STATUSES.has(next.status) || seen.has(taskKey(next.spaceId, next.id))) break;
      seen.add(taskKey(next.spaceId, next.id));
      node = next;
    }
    return node;
  };
  // `whole`: a closed tree Show done added, with every branch and session in it.
  const taskNode = (t: TaskLike, section: string, project: string | null, path: Set<string>, whole = false): TreeNode => {
    const key = taskKey(t.spaceId, t.id);
    const nextPath = new Set(path).add(key);
    const kids = path.size < MAX_DEPTH
      ? childrenOf(t).filter((k) => !nextPath.has(taskKey(k.spaceId, k.id))
        // Off, only the desk's: a branch stays only when a session open on the desk is in it.
        && (whole || isClosedShown(k) || (input.allTasks ? OPEN_STATUSES.has(k.status) || holdsDeskSession(k) : holdsDeskSession(k))))
      : [];
    const sessions = sessionsOfTask(t).filter((s) => whole || input.allTasks || deskIds.has(s.id)).map(leaf);
    return {
      key: `${section}:${key}`,
      kind: 'task',
      id: t.id,
      title: taskName(t),
      state: taskState(t),
      rel: t.parentId ? 'sub' : t.originId ? 'spun' : null,
      otherProject: t.project !== project ? brainProjectName(t.spaceId, t.project) : null,
      sessions,
      chips: taskChips(t, input.viewer, input.now ?? Date.now()),
      // A closed branch Show done keeps is shown whole, like a closed tree of its own.
      children: kids.map((k) => taskNode(k, section, project, nextPath, whole || isClosedShown(k))),
    };
  };

  // ---- session trees (a session without a task) ----
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
  const sessionNode = (s: AllSession, section: string, projectId: string | null, path: Set<string>, isChild: boolean, whole = false): TreeNode => {
    const nextPath = new Set(path).add(s.id);
    const kids = path.size < MAX_DEPTH
      ? sessionChildren(s).filter((k) => !nextPath.has(k.id) && (whole || input.allTasks || sessionHoldsDesk(k)))
      : [];
    const own = s.projectId ?? null;
    return {
      key: `${section}:${s.id}`,
      kind: 'session',
      id: s.id,
      title: s.summary || 'Untitled session',
      state: s.archivedAt && !deskIds.has(s.id) ? FINISHED : input.stateOfSession(s),
      rel: isChild ? 'sub' : null,
      otherProject: own !== projectId ? cockpitProjectName(s.spaceId, own) : null,
      sessions: [leaf(s)],
      children: kids.map((k) => sessionNode(k, section, projectId, nextPath, true, whole)),
    };
  };

  // ---- sections, in the desk's order ----
  const sections = new Map<string, {
    title: string; roots: Map<string, () => TreeNode>; project?: TreeSection['project']; doneMore?: boolean;
    /** Show done: closed trees, added after the section's other trees unless one of those shows them already. */
    closedRoots?: Map<string, TaskLike>;
  }>();
  const sectionFor = (key: string, title: string, project?: TreeSection['project']) => {
    if (!sections.has(key)) sections.set(key, { title, roots: new Map(), ...(project ? { project } : {}) });
    return sections.get(key)!;
  };
  for (const d of desk) {
    const s = sessionById.get(d.sessionId);
    if (!s) continue;
    const hasTask = Boolean(s.taskId && board);
    const task = hasTask ? tasks.get(taskKey(s.spaceId, s.taskId!)) : undefined;
    // Its task is not on the board yet (just made): it shows once the board has it, never as a bare session meanwhile.
    if (hasTask && !task) continue;
    if (task) {
      const key = `t:${task.spaceId}/${task.project ?? ''}`;
      const section = sectionFor(key, brainProjectName(task.spaceId, task.project), { spaceId: task.spaceId, id: task.project });
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
  // A desk session without a task still names its project: with All tasks or Show done, that project's tasks show too.
  if ((input.allTasks || input.showDone) && board) {
    for (const d of desk) {
      const s = sessionById.get(d.sessionId);
      if (!s || s.taskId) continue;
      const brain = brainProjectOf(input.projects, s.spaceId, s.projectId ?? null);
      if (brain) sectionFor(`t:${s.spaceId}/${brain}`, brainProjectName(s.spaceId, brain), { spaceId: s.spaceId, id: brain });
    }
  }
  // ---- all tasks: every open tree of each desk project, after the trees the desk holds ----
  if (input.allTasks && board) {
    for (const [key, section] of sections) {
      if (!section.project?.id) continue;
      const { spaceId, id: project } = section.project;
      for (const t of board.tasks) {
        if (t.spaceId !== spaceId || t.project !== project || !OPEN_STATUSES.has(t.status)) continue;
        const root = rootOfTask(t);
        const rootKey = taskKey(root.spaceId, root.id);
        if (!section.roots.has(rootKey)) section.roots.set(rootKey, () => taskNode(root, key, project, new Set()));
      }
    }
  }
  // ---- show done: each desk project's closed trees, then its finished sessions without a task, newest first ----
  if (input.showDone) {
    for (const [key, section] of [...sections]) {
      if (!section.project?.id) continue;
      const { spaceId, id: project } = section.project;
      for (const t of closedTasks) {
        if (t.spaceId !== spaceId || t.project !== project) continue;
        const root = closedRootOf(t);
        section.closedRoots ??= new Map();
        section.closedRoots.set(taskKey(root.spaceId, root.id), root);
      }
      if (input.closed?.more.has(`${spaceId}/${project}`)) section.doneMore = true;
    }
    const deskProjects = new Map<string, { spaceId: string; projectId: string | null }>();
    for (const d of desk) {
      const s = sessionById.get(d.sessionId);
      if (s) deskProjects.set(`${s.spaceId}/${s.projectId ?? ''}`, { spaceId: s.spaceId, projectId: s.projectId ?? null });
    }
    for (const { spaceId, projectId } of deskProjects.values()) {
      const key = `s:${spaceId}/${projectId ?? ''}`;
      const limit = input.doneLimit?.(key) ?? DONE_PAGE;
      let added = 0;
      // The host lists sessions newest first.
      for (const s of live) {
        if (!s.archivedAt || deskIds.has(s.id) || s.taskId || s.spaceId !== spaceId || (s.projectId ?? null) !== projectId) continue;
        const root = rootOfSession(s);
        const section = sectionFor(key, cockpitProjectName(spaceId, projectId));
        if (section.roots.has(root.id)) continue;
        if (added === limit) { section.doneMore = true; break; }
        section.roots.set(root.id, () => sessionNode(root, key, projectId, new Set(), false, true));
        added++;
      }
    }
  }
  return [...sections.entries()].map(([key, { title, roots, project, doneMore, closedRoots }]) => {
    const nodes = [...roots.values()].map((make) => make());
    if (closedRoots?.size) {
      const shown = new Set<string>();
      const walk = (n: TreeNode) => { if (n.kind === 'task') shown.add(n.id); n.children.forEach(walk); };
      nodes.forEach(walk);
      for (const root of closedRoots.values()) {
        if (shown.has(root.id)) continue;
        const node = taskNode(root, key, project?.id ?? null, new Set(), true);
        walk(node);
        nodes.push(node);
      }
    }
    return { key, title, nodes, ...(project ? { project } : {}), ...(doneMore ? { doneMore } : {}) };
  });
}

function fromLineage(t: LineageTask): TaskLike {
  return { id: t.id, spaceId: t.spaceId, project: t.project, title: t.title, ...(t.displayTitle ? { displayTitle: t.displayTitle } : {}), status: t.status, parentId: t.parentId, originId: t.originId };
}

/** Open tasks of a section's project that its trees don't show: what "N more open tasks in …" counts. */
export function moreOpenTasks(section: TreeSection, tasks: Array<Pick<BoardTask, 'id' | 'spaceId' | 'project' | 'status'>>): number {
  if (!section.project) return 0;
  const shown = new Set<string>();
  const walk = (n: TreeNode) => { if (n.kind === 'task') shown.add(n.id); n.children.forEach(walk); };
  section.nodes.forEach(walk);
  return tasks.filter((t) => OPEN_STATUSES.has(t.status) && t.spaceId === section.project!.spaceId && t.project === section.project!.id && !shown.has(t.id)).length;
}
