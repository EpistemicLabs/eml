// The Tasks view's model (components/tasks/TasksView.tsx): every open brain
// task of every space, grouped the way the user works through them — whose
// turn it is first, then what runs, what is scheduled, what is active and what
// is planned — and what was done in the last seven days. A task with steps
// (sub-tasks) shows once, with its progress; its steps lend it their state: a
// step waiting on the user puts the task in Your turn. Pure, for the tests.

export type OverviewTask = {
  id: string;
  title: string;
  content: string;
  status: string;
  scope: string;
  updatedAt: string;
  parentId: string | null;
  priority: string | null;
  stage: string | null;
  checkpoint: string | null;
  dependsOn: string[];
  waitingOn: { who: string; why: string; since: string } | null;
  dueDate: string | null;
  spaceId: string;
  spaceName: string;
  /** The brain project's name, or null for a task outside a project. */
  project: string | null;
  /** Its subjects; a cycle is one (cycle-<year>-w<week>). */
  subjects: string[];
  /** Who should act on it: users or agents (handles). */
  assignees: string[];
};

export type RawTask = {
  id: string; title: string | null; content: string; status: string; scope: string; updated_at: string;
  parent_id?: string | null;
  subjects?: string[];
  properties?: {
    priority?: string; stage?: string; checkpoint?: string; depends_on?: string[]; due_date?: string; assignee_ids?: string[];
    waiting_on?: { who?: string; why?: string; since?: string };
  };
};

export function toOverviewTask(raw: RawTask, space: { id: string; name: string }, projects: ReadonlyMap<string, string>): OverviewTask {
  const p = raw.properties ?? {};
  const projectId = raw.scope.startsWith('project.') ? raw.scope.slice('project.'.length) : null;
  return {
    id: raw.id,
    title: raw.title ?? raw.content.split('\n')[0].slice(0, 80),
    content: raw.content,
    status: raw.status,
    scope: raw.scope,
    updatedAt: raw.updated_at,
    parentId: raw.parent_id ?? null,
    priority: p.priority ?? null,
    stage: p.stage ?? null,
    checkpoint: p.checkpoint ?? null,
    dependsOn: Array.isArray(p.depends_on) ? p.depends_on : [],
    waitingOn: p.waiting_on?.who ? { who: p.waiting_on.who, why: p.waiting_on.why ?? '', since: p.waiting_on.since ?? '' } : null,
    dueDate: p.due_date ?? null,
    spaceId: space.id,
    spaceName: space.name,
    project: projectId ? projects.get(projectId) ?? projectId : null,
    subjects: Array.isArray(raw.subjects) ? raw.subjects : [],
    assignees: Array.isArray(p.assignee_ids) ? p.assignee_ids : [],
  };
}

/** A session working on a task right now. */
export type TaskSession = { taskId: string; sessionId: string; name: string; working: boolean };

/** A job attached to a task (its next run). */
export type TaskJob = { id: string; name: string; taskId: string | null; nextRun: string | null; paused: boolean; ended: boolean };

export type OverviewItem = {
  task: OverviewTask;
  /** Its steps, open and done (as far as the lists reach). */
  steps: OverviewTask[];
  done: number;
  /** Whose turn it is and why: the task's own wait, else a step's (stepTitle says which). */
  waiting: { who: string; why: string; since: string; stepTitle: string | null } | null;
  /** The step (or the task itself) a session works on now. */
  running: { title: string; sessionName: string } | null;
  jobs: TaskJob[];
};

export type Overview = {
  yourTurn: OverviewItem[];
  running: OverviewItem[];
  scheduled: Array<{ job: TaskJob; item: OverviewItem | null }>;
  active: OverviewItem[];
  planned: OverviewItem[];
  done: OverviewItem[];
  openCount: number;
};

const PRIORITY: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const rank = (task: OverviewTask) => PRIORITY[task.priority ?? 'normal'] ?? 2;
const OPEN = new Set(['planned', 'active']);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function buildOverview(input: {
  open: OverviewTask[];
  resolved: OverviewTask[];
  sessions: TaskSession[];
  jobs: TaskJob[];
  now: Date;
}): Overview {
  const all = new Map<string, OverviewTask>();
  for (const task of [...input.resolved, ...input.open]) all.set(task.id, task);
  const stepsOf = new Map<string, OverviewTask[]>();
  for (const task of all.values()) {
    if (!task.parentId || !all.has(task.parentId)) continue;
    stepsOf.set(task.parentId, [...(stepsOf.get(task.parentId) ?? []), task]);
  }
  // A step shows on its parent; one whose parent is not in the lists stands on its own.
  const isTop = (task: OverviewTask) => !task.parentId || !all.has(task.parentId);
  const working = new Map(input.sessions.filter((s) => s.working).map((s) => [s.taskId, s]));

  const item = (task: OverviewTask): OverviewItem => {
    const steps = stepsOf.get(task.id) ?? [];
    const waitingStep = steps.find((s) => OPEN.has(s.status) && s.waitingOn);
    const waiting = task.waitingOn
      ? { ...task.waitingOn, stepTitle: null }
      : waitingStep ? { ...waitingStep.waitingOn!, stepTitle: waitingStep.title } : null;
    const runningTask = [task, ...steps].find((t) => working.has(t.id));
    return {
      task, steps,
      done: steps.filter((s) => s.status === 'resolved').length,
      waiting,
      running: runningTask ? { title: runningTask.title, sessionName: working.get(runningTask.id)!.name } : null,
      jobs: input.jobs.filter((job) => job.taskId === task.id && !job.ended),
    };
  };

  const byPriority = (a: OverviewItem, b: OverviewItem) => rank(a.task) - rank(b.task) || b.task.updatedAt.localeCompare(a.task.updatedAt);
  const open = input.open.filter(isTop).map(item);
  const yourTurn = open.filter((i) => i.waiting)
    .sort((a, b) => rank(a.task) - rank(b.task) || a.waiting!.since.localeCompare(b.waiting!.since));
  const rest = open.filter((i) => !i.waiting);
  const running = rest.filter((i) => i.running).sort(byPriority);
  const idle = rest.filter((i) => !i.running);

  const items = new Map(open.map((i) => [i.task.id, i]));
  const scheduled = input.jobs
    .filter((job) => !job.ended)
    .map((job) => ({ job, item: job.taskId ? items.get(job.taskId) ?? null : null }))
    .sort((a, b) => (a.job.nextRun ?? '9').localeCompare(b.job.nextRun ?? '9'));

  const done = input.resolved
    .filter((task) => isTop(task) && input.now.getTime() - new Date(task.updatedAt).getTime() < WEEK_MS)
    .map(item)
    .sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));

  return {
    yourTurn,
    running,
    scheduled,
    active: idle.filter((i) => i.task.status === 'active').sort(byPriority),
    planned: idle.filter((i) => i.task.status === 'planned').sort(byPriority),
    done,
    openCount: open.length,
  };
}

/** The filters of the view: space, project, priority and words in the title or text. */
export type OverviewFilter = { spaceId: string | null; project: string | null; priority: string | null; words: string };

export function matches(task: OverviewTask, filter: OverviewFilter): boolean {
  if (filter.spaceId && task.spaceId !== filter.spaceId) return false;
  if (filter.project && task.project !== filter.project) return false;
  if (filter.priority && (task.priority ?? 'normal') !== filter.priority) return false;
  const words = filter.words.toLowerCase().split(/\s+/).filter(Boolean);
  const text = `${task.title} ${task.content}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

/** A project and its open tasks, as the Tasks view shows it. */
export type ProjectGroup = {
  key: string;
  spaceId: string;
  spaceName: string;
  /** The brain project id, or null for tasks outside a project. */
  brainId: string | null;
  name: string;
  items: OverviewItem[];
  waiting: number;
  running: number;
  due: number;
  /** Something waits, runs, is due, or changed in the last seven days. */
  active: boolean;
  lastUpdate: string;
};

/** Due today or earlier, in the browser's day. */
export const isDue = (task: OverviewTask, today: string) => Boolean(task.dueDate && task.dueDate.slice(0, 10) <= today);

/**
 * The open tasks by project, the projects with something going on first:
 * waiting on the user, then running, then due, then the latest change. Within a
 * project: whose turn first, then running, then by priority and change.
 */
export function groupByProject(overview: Overview, now: Date): ProjectGroup[] {
  const today = now.toLocaleDateString('en-CA');
  const items = [...overview.yourTurn, ...overview.running, ...overview.active, ...overview.planned];
  const groups = new Map<string, ProjectGroup>();
  for (const item of items) {
    const t = item.task;
    const brainId = t.scope.startsWith('project.') ? t.scope.slice('project.'.length) : null;
    const key = `${t.spaceId}|${brainId ?? ''}`;
    const group = groups.get(key) ?? {
      key, spaceId: t.spaceId, spaceName: t.spaceName, brainId, name: t.project ?? 'No project',
      items: [], waiting: 0, running: 0, due: 0, active: false, lastUpdate: '',
    };
    group.items.push(item);
    if (item.waiting) group.waiting += 1;
    if (item.running) group.running += 1;
    if (isDue(t, today)) group.due += 1;
    if (t.updatedAt > group.lastUpdate) group.lastUpdate = t.updatedAt;
    groups.set(key, group);
  }
  const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();
  const order = (i: OverviewItem) => (i.waiting ? 0 : i.running ? 1 : 2);
  return [...groups.values()]
    .map((g) => ({
      ...g,
      active: g.waiting > 0 || g.running > 0 || g.due > 0 || g.lastUpdate >= weekAgo,
      items: g.items.sort((a, b) => order(a) - order(b) || rank(a.task) - rank(b.task) || b.task.updatedAt.localeCompare(a.task.updatedAt)),
    }))
    .sort((a, b) => b.waiting - a.waiting || b.running - a.running || b.due - a.due || b.lastUpdate.localeCompare(a.lastUpdate));
}


/** How many cycles a task was carried through: its cycle subjects but one. */
export const carried = (task: OverviewTask) => Math.max(0, task.subjects.filter((s) => s.startsWith('cycle-')).length - 1);

/** My tasks in Linear's Focus order; each task in the first group it fits. */
export type Focus = {
  needsYou: OverviewItem[];
  urgentDue: OverviewItem[];
  blocking: OverviewItem[];
  thisCycle: OverviewItem[];
  inProgress: OverviewItem[];
  backlog: OverviewItem[];
};

/**
 * `waitsNow`: whether a session on this task is waiting for the user right now. With it, the live
 * state decides "needs you" and a task's waiting_on only gives the question; a wait no session
 * holds any more (an old handoff) no longer counts.
 */
export function focusGroups(overview: Overview, cycleId: string | null, now: Date, waitsNow?: (taskId: string) => boolean): Focus {
  const today = now.toLocaleDateString('en-CA');
  const weekAgo = new Date(now.getTime() - WEEK_MS).toISOString();
  const items = [...overview.yourTurn, ...overview.running, ...overview.active, ...overview.planned];
  const blockers = new Set(items.flatMap((i) => [i.task, ...i.steps]).filter((t) => OPEN.has(t.status)).flatMap((t) => t.dependsOn));
  const focus: Focus = { needsYou: [], urgentDue: [], blocking: [], thisCycle: [], inProgress: [], backlog: [] };
  for (const item of items) {
    const t = item.task;
    const needsYou = waitsNow ? [t, ...item.steps].some((x) => waitsNow(x.id)) : Boolean(item.waiting);
    if (needsYou) focus.needsYou.push(item);
    else if (t.priority === 'urgent' || isDue(t, today)) focus.urgentDue.push(item);
    else if (blockers.has(t.id)) focus.blocking.push(item);
    else if (cycleId && t.subjects.includes(cycleId) && !item.running) focus.thisCycle.push(item);
    // Active and touched this week, or a session on it now; an old "active" is backlog in all but name.
    else if (item.running || (t.status === 'active' && t.updatedAt >= weekAgo)) focus.inProgress.push(item);
    else focus.backlog.push(item);
  }
  const byRank = (a: OverviewItem, b: OverviewItem) => rank(a.task) - rank(b.task) || b.task.updatedAt.localeCompare(a.task.updatedAt);
  for (const list of Object.values(focus)) list.sort(byRank);
  return focus;
}

/** A cycle's tasks: done of all, from the open and the closed lists. */
export function cycleProgress(open: OverviewTask[], resolved: OverviewTask[], cycleId: string) {
  const inCycle = (t: OverviewTask) => t.subjects.includes(cycleId);
  const done = resolved.filter(inCycle).length;
  const openIn = open.filter(inCycle);
  return { done, total: done + openIn.length, inProgress: openIn.filter((t) => t.status === 'active').length };
}


/** Why a task counts as an agent's: the most telling reason first. */
export type AgentReason = 'running' | 'scheduled' | 'step' | 'assigned';

/**
 * Tasks handled by agents (Linear's delegate): a session started by a session,
 * a job or the runner works on it now, a job is attached to it, the runner will
 * start it (a planned step with a checkpoint), or an agent is assigned. The
 * user stays the owner; such a task shows in My tasks only while it needs him.
 */
export function agentTasks(input: {
  tasks: OverviewTask[];
  jobs: TaskJob[];
  /** Agent sessions (workers) and the task each works on, and whether it works now. */
  agentSessions: Array<{ taskId: string; working: boolean }>;
  /** Agent handles (e.g. atlas): a task assigned to one is an agent's. */
  agents: string[];
}): Map<string, AgentReason> {
  const reasons = new Map<string, AgentReason>();
  const set = (id: string, reason: AgentReason) => { if (!reasons.has(id)) reasons.set(id, reason); };
  for (const s of input.agentSessions) if (s.working) set(s.taskId, 'running');
  for (const j of input.jobs) if (j.taskId && !j.ended) set(j.taskId, 'scheduled');
  for (const s of input.agentSessions) set(s.taskId, 'running');
  for (const t of input.tasks) {
    if (t.parentId && t.checkpoint && t.status === 'planned') set(t.id, 'step');
    else if (t.assignees.some((a) => input.agents.includes(a))) set(t.id, 'assigned');
  }
  return reasons;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A task's title as people read it. The brain keeps a kebab-case anchor for
 * agents (wikilinks, lookups); the views show it as words:
 * "aktivdog-conversation-history-missing-after-move" → "Aktivdog conversation
 * history missing after move", a session placeholder → "Session 18 Nov · fa1d29c3".
 */
export function readableTitle(title: string): string {
  const placeholder = /^session-(\d{4})-(\d{2})-(\d{2})-([0-9a-f]{8})$/.exec(title);
  if (placeholder) return `Session ${Number(placeholder[3])} ${MONTHS[Number(placeholder[2]) - 1] ?? placeholder[2]} · ${placeholder[4]}`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(title)) return title;
  const words = title.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
