// The tasks card next to the sidebar: for each project with a session open on this desk, the trees
// those sessions belong to (taskTree.ts). A row's dot is its state; the active pane's row is marked;
// a click focuses the session's pane or opens it, and a task without a session starts one on it.
import { useCallback, useMemo, useState } from 'react';

import { allSessionState, MARK_WORD, sessionMark, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { projectsOfSpace, type ProjectsBySpace } from '@/hooks/useProjectsState';
import { projectIdOfBrain } from '@/lib/project-lead';
import { closedAsTask, startTaskSession, taskName, useClosedTasks, useTaskBoard } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { Empty, FOCUS, LABEL, Switch, Tree, TreeItem } from '@/shared/view/ui';
import { lineOf, TaskNodeContent } from '@/components/task-tree/TaskNodeContent';
import { Search } from 'lucide-react';
import { openTaskSearch, tellOnDesk, tellStartProblem } from '@/components/command-palette/openTask';
import { MOD } from '@/components/top-bar/shortcuts';
import { addWorkerPane, getSessionView, openSessionInSpace, useActiveDesk, useActivePane } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';
import { requestTaskPanel } from '@/stores/useTaskViewStore';
import { setTopView } from '@/stores/useTopViewStore';
import { useTurnStore } from '@/stores/useTurnStateStore';

import {
  moreOpenTasks, buildTaskTree, deskTaskProjects, DONE_PAGE, type ClosedTasks, type DeskSession, type NodeState, type ProjectName, type SessionLeaf, type TreeNode,
} from './taskTree';

const FOLDS_KEY = 'cockpit-tasks-card-folds';

/** A closed (done, dropped or replaced) task's row: it opens the task's panel, where Reopen is. */
const isClosedTask = (node: TreeNode) => node.kind === 'task' && node.state.hue === 'done';

function readFolds(deskId: string): string[] {
  try {
    const all = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Record<string, string[]>;
    return Array.isArray(all[deskId]) ? all[deskId] : [];
  } catch {
    return [];
  }
}

function writeFolds(deskId: string, folds: string[]) {
  try {
    const all = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '{}') as Record<string, string[]>;
    localStorage.setItem(FOLDS_KEY, JSON.stringify({ ...all, [deskId]: folds }));
  } catch { /* storage blocked: folds last for this visit */ }
}

const SWITCHES_KEY = 'cockpit-tasks-card-switches';

/** The footer switches, kept per desk; both start off. */
interface Switches { showDone: boolean; allTasks: boolean }
const NO_SWITCHES: Switches = { showDone: false, allTasks: false };

function readSwitches(deskId: string): Switches {
  try {
    const all = JSON.parse(localStorage.getItem(SWITCHES_KEY) ?? '{}') as Record<string, Partial<Switches>>;
    const mine = all[deskId] ?? {};
    return { showDone: mine.showDone === true, allTasks: mine.allTasks === true };
  } catch {
    return NO_SWITCHES;
  }
}

function writeSwitches(deskId: string, switches: Switches) {
  try {
    const all = JSON.parse(localStorage.getItem(SWITCHES_KEY) ?? '{}') as Record<string, Switches>;
    localStorage.setItem(SWITCHES_KEY, JSON.stringify({ ...all, [deskId]: switches }));
  } catch { /* storage blocked: the switches last for this visit */ }
}

export function TasksCard({ projects: bySpace }: { projects: ProjectsBySpace }) {
  const desk = useActiveDesk();
  const activePane = useActivePane();
  const spaces = useSpaces();
  const { data: board, isPending } = useTaskBoard();
  const { sessions } = useAllSessions(true);
  const { turns } = useTurnStore();
  const [switchState, setSwitchState] = useState<{ deskId: string; value: Switches }>(() => ({ deskId: desk.id, value: readSwitches(desk.id) }));
  const { showDone, allTasks } = switchState.deskId === desk.id ? switchState.value : readSwitches(desk.id);
  const setSwitch = useCallback((name: keyof Switches, on: boolean) => {
    const next = { showDone, allTasks, [name]: on };
    writeSwitches(desk.id, next);
    setSwitchState({ deskId: desk.id, value: next });
  }, [desk.id, showDone, allTasks]);
  const [folds, setFolds] = useState<{ deskId: string; keys: string[] }>(() => ({ deskId: desk.id, keys: readFolds(desk.id) }));
  const folded = folds.deskId === desk.id ? folds.keys : readFolds(desk.id);

  const toggleFold = useCallback((key: string) => {
    const next = folded.includes(key) ? folded.filter((k) => k !== key) : [...folded, key];
    writeFolds(desk.id, next);
    setFolds({ deskId: desk.id, keys: next });
  }, [desk.id, folded]);

  const projectNames = useMemo<ProjectName[]>(() => spaces.flatMap((space) =>
    projectsOfSpace(bySpace, paneSpaceKey(space)).map((p) => ({ spaceId: space.id, projectId: p.projectId, brainProjectId: p.brainProjectId ?? null, name: p.displayName }))), [bySpace, spaces]);

  const deskSessions = useMemo<DeskSession[]>(() => desk.panes.flatMap((p) =>
    p.sessionId && (p.paneView === 'chat' || p.paneView === 'terminal') ? [{ sessionId: p.sessionId, paneId: p.id, view: p.paneView }] : []), [desk.panes]);

  // Show done: how many pages of closed work each section shows ("Show older" adds one); for this visit only.
  const [older, setOlder] = useState<Record<string, number>>({});
  const doneLimit = useCallback((sectionKey: string) => DONE_PAGE * (1 + (older[sectionKey] ?? 0)), [older]);
  const closedProjects = useMemo(() => (showDone
    ? deskTaskProjects({ board: board ?? null, sessions: sessions ?? [], desk: deskSessions, projects: projectNames })
      .map((p) => ({ ...p, limit: doneLimit(`t:${p.spaceId}/${p.project}`) }))
    : []), [showDone, board, sessions, deskSessions, projectNames, doneLimit]);
  const closedPages = useClosedTasks(closedProjects, showDone);
  // useQueries answers a new array on every render: the tree is built again only when a page's data changed.
  const pagesAt = closedPages.map((p) => p.dataUpdatedAt).join();
  const closed = useMemo<ClosedTasks>(() => {
    const tasks: ClosedTasks['tasks'] = [];
    const more = new Set<string>();
    closedPages.forEach((page, i) => {
      const p = closedProjects[i];
      if (!page.data || !p) return;
      tasks.push(...page.data.tasks);
      if (page.data.more) more.add(`${p.spaceId}/${p.project}`);
    });
    return { tasks, more };
  }, [closedProjects, pagesAt]); // eslint-disable-line react-hooks/exhaustive-deps -- closedPages is read through pagesAt

  const stateOfSession = useCallback((s: AllSession): NodeState => {
    const turn = turns[s.id];
    if (allSessionState(s, turn) === 'working') return { hue: 'agent', hollow: false, label: 'Working' };
    const mark = sessionMark(s, turn);
    if (mark === 'failed') return { hue: 'stopped', hollow: false, label: MARK_WORD[mark] };
    // A question, a wait, a result to check: all the person's turn, so all amber.
    if (mark) return { hue: 'you', hollow: false, label: MARK_WORD[mark] };
    return { hue: 'waiting', hollow: true, label: 'Idle' };
  }, [turns]);

  const sections = useMemo(() => buildTaskTree({
    board: board ?? null,
    sessions: sessions ?? [],
    desk: deskSessions,
    projects: projectNames,
    activeSessionId: activePane?.sessionId ?? null,
    showDone,
    closed,
    doneLimit,
    allTasks,
    viewOf: (id) => (getSessionView(id) === 'chat' ? 'chat' : 'terminal'),
    stateOfSession,
  }), [board, sessions, deskSessions, projectNames, activePane?.sessionId, showDone, closed, doneLimit, allTasks, stateOfSession]);

  const spaceKeyOf = (spaceId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    return space ? paneSpaceKey(space) : null;
  };
  const openSession = (leaf: SessionLeaf) => {
    openSessionInSpace(spaceKeyOf(leaf.spaceId), { surface: 'terminal', projectId: leaf.projectId, sessionId: leaf.id, chat: leaf.view === 'chat' });
  };
  /** A closed task row: the task's panel on the Tasks screen, where Reopen is (as ⌘K opens a closed task). */
  const openClosedTask = (node: TreeNode) => {
    const found = closedPages.flatMap((p) => p.data?.tasks ?? []).find((c) => c.id === node.id) ?? board?.closed?.find((c) => c.id === node.id);
    if (!found) { tellOnDesk(`${node.title} is closed and older than what the board holds: find it with ${MOD}K Open task.`); return; }
    requestTaskPanel(found.id, closedAsTask(found));
    setTopView('tasks');
  };
  const selectNode = (node: TreeNode) => {
    if (isClosedTask(node)) { openClosedTask(node); return; }
    const leaf = node.sessions.find((s) => s.current) ?? node.sessions.find((s) => s.open) ?? node.sessions[0];
    if (leaf) { openSession(leaf); return; }
    const task = node.kind === 'task' ? board?.tasks.find((t) => t.id === node.id) : undefined;
    if (!task?.project) return;
    // A task without a session: the host starts one on it with the task bound, and it opens in chat when that is
    // the user's view; an older host can't, so then a terminal pane starts it (the task-run path).
    const prompt = `Work on task ${task.id} ("${taskName(task)}") together with the user. Start by saying where it stands and what you would do next.`;
    void startTaskSession(task, { projectId: projectIdOfBrain(task.project), prompt, title: taskName(task), deskId: desk.id }).then((outcome) => {
      tellStartProblem(outcome, taskName(task));
      if (outcome.kind !== 'no_route') return;
      addWorkerPane({
        fromSessionId: null, projectId: projectIdOfBrain(task.project!), title: taskName(task), deskId: desk.id, taskId: task.id, prompt,
        ...(spaceKeyOf(task.spaceId) !== null ? { spaceId: spaceKeyOf(task.spaceId) } : {}),
      });
    });
  };

  const sessionWords = (leaf: SessionLeaf) => (leaf.open ? 'session open on this desk' : 'session');

  const renderNode = (node: TreeNode) => {
    // A closed task's row opens its panel, so its sessions are rows of their own, even a single one.
    const one = node.sessions.length === 1 && !isClosedTask(node) ? node.sessions[0] : null;
    const leaves = one ? [] : node.sessions;
    const hasChildren = leaves.length > 0 || node.children.length > 0;
    const title = node.title;
    const onDesk = node.sessions.some((s) => s.open);
    return (
      <TreeItem
        key={node.key}
        line={lineOf(node.rel)}
        label={`${title}, ${node.state.label}${node.otherProject ? `, in ${node.otherProject}` : ''}${one ? `, ${sessionWords(one)}` : ''}`}
        selected={Boolean(one?.current)}
        expanded={hasChildren ? !folded.includes(node.key) : undefined}
        onToggle={() => toggleFold(node.key)}
        onSelect={() => selectNode(node)}
        // On the desk: the text colour; not on the desk: muted (the row's name says it too).
        content={<TaskNodeContent state={node.state} title={title} muted={!onDesk} aside={node.otherProject} titleData={{ 'data-on-desk': onDesk }} wrap />}
      >
        {leaves.map((leaf) => (
          <TreeItem
            key={`${node.key}:${leaf.id}`}
            label={`${leaf.title}, ${sessionWords(leaf)}`}
            selected={leaf.current}
            onSelect={() => openSession(leaf)}
            content={(
              <span data-on-desk={leaf.open} className={cn('min-w-0 flex-1 truncate', leaf.open ? 'text-foreground' : 'text-muted-foreground')}>{leaf.title}</span>
            )}
          />
        ))}
        {node.children.map(renderNode)}
      </TreeItem>
    );
  };

  return (
    <aside aria-label={`Tasks on ${desk.name}`} className="glass flex h-full w-(--size-tasks-card) flex-col overflow-hidden rounded-xl">
      <div className="px-3 pt-3 pb-2">
        <h2 className="truncate text-body font-semibold text-foreground">Tasks · {desk.name}</h2>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2">
        {/* Until the board is in, a session with a task would show as a bare session and then jump. */}
        {isPending && <Empty>Loading tasks…</Empty>}
        {!isPending && sections.length === 0 && <Empty>No sessions on this desk yet.</Empty>}
        {!isPending && sections.map((section) => (
          <section key={section.key} aria-label={section.title} className="flex flex-col gap-1">
            <h3 className={cn(LABEL, 'px-2 text-foreground')}>{section.title}</h3>
            <Tree label={section.title}>{section.nodes.map(renderNode)}</Tree>
            {(() => {
              const more = moreOpenTasks(section, board?.tasks ?? []);
              return more > 0 && section.project ? (
                <button type="button" onClick={() => openTaskSearch(section.project!.id)} className={cn('min-h-(--target-min) self-start rounded-md px-2 text-caption text-muted-foreground hover:text-foreground', FOCUS)}>
                  {more} more open task{more === 1 ? '' : 's'} in {section.title}
                </button>
              ) : null;
            })()}
            {showDone && section.doneMore && (
              <button type="button" onClick={() => setOlder((prev) => ({ ...prev, [section.key]: (prev[section.key] ?? 0) + 1 }))} className={cn('min-h-(--target-min) self-start rounded-md px-2 text-caption text-muted-foreground hover:text-foreground', FOCUS)}>
                Show older in {section.title}
              </button>
            )}
          </section>
        ))}
        {!isPending && (
          <button type="button" onClick={() => openTaskSearch()} className={cn('flex min-h-(--target-comfortable) items-center gap-2 rounded-lg border border-dashed border-border px-2 text-ui text-muted-foreground hover:text-foreground', FOCUS)}>
            <Search aria-hidden className="size-3.5" />
            <span className="flex-1 text-left">Open task…</span>
            <kbd className="font-code text-caption">{MOD}K</kbd>
          </button>
        )}
      </div>
      <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
        <label className="flex min-h-(--target-min) items-center justify-between gap-2 text-ui text-foreground">
          Show done
          <Switch checked={showDone} onChange={(on) => setSwitch('showDone', on)} ariaLabel="Show done" />
        </label>
        <label className="flex min-h-(--target-min) items-center justify-between gap-2 text-ui text-foreground">
          All tasks
          <Switch checked={allTasks} onChange={(on) => setSwitch('allTasks', on)} ariaLabel="All tasks" />
        </label>
      </div>
    </aside>
  );
}
