// The tasks card next to the sidebar: for each project with a session open on this desk, the trees
// those sessions belong to (taskTree.ts). A row's dot is its state; the active pane's row is marked;
// a click focuses the session's pane or opens it, and a task without a session starts one on it.
import { useCallback, useMemo, useState } from 'react';
import { MessageSquare, SquareTerminal } from 'lucide-react';

import { allSessionState, MARK_WORD, sessionMark, type AllSession } from '@/components/sidebar/allSessions';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { projectsOfSpace, type ProjectsBySpace } from '@/hooks/useProjectsState';
import { projectIdOfBrain } from '@/lib/project-lead';
import { readable, useTaskBoard } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { Dot, Empty, LABEL, Switch, Tree, TreeItem } from '@/shared/view/ui';
import { addWorkerPane, getSessionView, openSessionInSpace, useActiveDesk, useActivePane } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';

import { buildTaskTree, type DeskSession, type NodeState, type ProjectName, type SessionLeaf, type TreeNode } from './taskTree';

const FOLDS_KEY = 'cockpit-tasks-card-folds';

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

export function TasksCard({ projects: bySpace }: { projects: ProjectsBySpace }) {
  const desk = useActiveDesk();
  const activePane = useActivePane();
  const spaces = useSpaces();
  const { data: board, isPending } = useTaskBoard();
  const { sessions } = useAllSessions(true);
  const { turns } = useTurnStore();
  const [showDone, setShowDone] = useState(false);
  const [allSessions, setAllSessions] = useState(true);
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
    allSessions,
    viewOf: (id) => (getSessionView(id) === 'chat' ? 'chat' : 'terminal'),
    stateOfSession,
  }), [board, sessions, deskSessions, projectNames, activePane?.sessionId, showDone, allSessions, stateOfSession]);

  const spaceKeyOf = (spaceId: string) => {
    const space = spaces.find((s) => s.id === spaceId);
    return space ? paneSpaceKey(space) : null;
  };
  const openSession = (leaf: SessionLeaf) => {
    openSessionInSpace(spaceKeyOf(leaf.spaceId), { surface: 'terminal', projectId: leaf.projectId, sessionId: leaf.id, chat: leaf.view === 'chat' });
  };
  const selectNode = (node: TreeNode) => {
    const leaf = node.sessions.find((s) => s.current) ?? node.sessions.find((s) => s.open) ?? node.sessions[0];
    if (leaf) { openSession(leaf); return; }
    const task = node.kind === 'task' ? board?.tasks.find((t) => t.id === node.id) : undefined;
    if (!task?.project) return;
    // A task without a session: start one on it, with the task as its brief (the task-run path).
    addWorkerPane({
      fromSessionId: null, projectId: projectIdOfBrain(task.project), title: readable(task.title), deskId: desk.id, taskId: task.id,
      prompt: `Work on task ${task.id} ("${readable(task.title)}") together with the user. Start by saying where it stands and what you would do next.`,
      ...(spaceKeyOf(task.spaceId) !== null ? { spaceId: spaceKeyOf(task.spaceId) } : {}),
    });
  };

  const sessionIcon = (leaf: SessionLeaf) => {
    const Icon = leaf.view === 'chat' ? MessageSquare : SquareTerminal;
    return <Icon aria-hidden className={cn('size-3 flex-shrink-0', leaf.open ? 'text-foreground' : 'text-muted-foreground')} />;
  };
  const sessionWords = (leaf: SessionLeaf) => `${leaf.view === 'chat' ? 'Chat' : 'Terminal'} session${leaf.open ? ', open on this desk' : ''}`;

  const renderNode = (node: TreeNode) => {
    const one = node.sessions.length === 1 ? node.sessions[0] : null;
    const leaves = one ? [] : node.sessions;
    const hasChildren = leaves.length > 0 || node.children.length > 0;
    const title = node.kind === 'task' ? readable(node.title) : node.title;
    return (
      <TreeItem
        key={node.key}
        line={node.rel === 'spun' ? 'dashed' : node.rel === 'sub' ? 'solid' : undefined}
        label={`${title}, ${node.state.label}${node.otherProject ? `, in ${node.otherProject}` : ''}${one ? `, ${sessionWords(one).toLowerCase()}` : ''}`}
        selected={Boolean(one?.current)}
        expanded={hasChildren ? !folded.includes(node.key) : undefined}
        onToggle={() => toggleFold(node.key)}
        onSelect={() => selectNode(node)}
        content={(
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <Dot hue={node.state.hue} hollow={node.state.hollow} />
            <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
            {node.otherProject && <span className="flex-shrink-0 truncate text-caption text-muted-foreground">{node.otherProject}</span>}
            {one && sessionIcon(one)}
          </span>
        )}
      >
        {leaves.map((leaf) => (
          <TreeItem
            key={`${node.key}:${leaf.id}`}
            label={`${leaf.title}, ${sessionWords(leaf).toLowerCase()}`}
            selected={leaf.current}
            onSelect={() => openSession(leaf)}
            content={(
              <span className="flex min-w-0 flex-1 items-center gap-2">
                {sessionIcon(leaf)}
                <span className="min-w-0 flex-1 truncate">{leaf.title}</span>
              </span>
            )}
          />
        ))}
        {node.children.map(renderNode)}
      </TreeItem>
    );
  };

  return (
    <aside aria-label={`Tasks on ${desk.name}`} className="glass flex h-full w-(--size-tasks-card) flex-col overflow-hidden rounded-xl">
      <div className="flex flex-col gap-1 px-3 pt-3 pb-2">
        <h2 className="truncate text-body font-semibold text-foreground">Tasks · {desk.name}</h2>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted-foreground">
          <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block w-(--tree-tick) border-t border-border-strong" />sub-task</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden className="inline-block w-(--tree-tick) border-t border-dashed border-border-strong" />spun off</span>
          <span className="inline-flex items-center gap-1"><Dot hue="you" />needs you</span>
          <span className="inline-flex items-center gap-1"><Dot hue="agent" />working</span>
          <span className="inline-flex items-center gap-1"><Dot hue="waiting" hollow />waiting</span>
          <span className="inline-flex items-center gap-1"><Dot hue="stopped" />stuck</span>
          <span className="inline-flex items-center gap-1"><Dot hue="done" />done</span>
        </p>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-2 pb-2">
        {/* Until the board is in, a task-system session would show as a bare session and then jump. */}
        {isPending && <Empty>Loading tasks…</Empty>}
        {!isPending && sections.length === 0 && <Empty>No sessions on this desk yet.</Empty>}
        {!isPending && sections.map((section) => (
          <section key={section.key} aria-label={section.title} className="flex flex-col gap-1">
            <h3 className={cn(LABEL, 'px-2 text-foreground')}>{section.title}</h3>
            <Tree label={section.title}>{section.nodes.map(renderNode)}</Tree>
          </section>
        ))}
      </div>
      <div className="flex flex-col gap-1 border-t border-border px-3 py-2">
        <label className="flex min-h-(--target-min) items-center justify-between gap-2 text-ui text-foreground">
          Show done
          <Switch checked={showDone} onChange={setShowDone} ariaLabel="Show done" />
        </label>
        <label className="flex min-h-(--target-min) items-center justify-between gap-2 text-ui text-foreground">
          All sessions
          <Switch checked={allSessions} onChange={setAllSessions} ariaLabel="All sessions" />
        </label>
      </div>
    </aside>
  );
}
