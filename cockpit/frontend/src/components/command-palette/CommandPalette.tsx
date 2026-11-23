// Cmd/Ctrl+K command palette: jump to sessions, projects and brain engrams,
// start new sessions, switch the active pane's view and open Settings tabs.
// Filtering and ordering happen here; cmdk only handles highlight + keys.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronRight,
  Brain,
  Clock,
  FileDiff,
  FolderGit2,
  Folder,
  MessageSquare,
  MessageSquarePlus,
  NotebookPen,
  Settings as SettingsIcon,
  SquareTerminal,
  SunMoon,
  X,
  type LucideIcon,
  CalendarClock,
  Inbox,
  Keyboard,
  LayoutGrid,
  ListChecks,
} from 'lucide-react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/shared/view/ui';
import { useTheme } from '@/contexts/ThemeContext';
import { useViewEnabled } from '@/lib/pane-views';
import { useProviders } from '@/lib/providers';
import { useList } from '@/lib/queries';
import { useEngramPanel } from '@/lib/engram-panel';
import type { Engram, EngramStatus } from '@/lib/types';
import { activateDesk, openInPane, useActiveDeskId, useActiveSpaceId, useDesks, type PaneView } from '@/stores/usePaneStore';
import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { taskState } from '@/components/tasks-card/taskTree';
import { locateTask, locationWords, projectNameOf, searchTasks, type TaskLocation } from '@/lib/open-task';
import { type BoardTask, readable, taskName, useTaskBoard } from '@/lib/task-board';
import { Dot } from '@/shared/view/ui';
import { openTask, TASK_SEARCH_EVENT } from './openTask';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';
import { setTopView } from '@/stores/useTopViewStore';
import { requestTaskPanel } from '@/stores/useTaskViewStore';
import { keysHint, MOD, orderedDesks, setShortcutSheet, SHORTCUTS } from '@/components/top-bar/shortcuts';
import { openTaskView } from '@/components/top-bar/useCockpitShortcuts';
import type { LLMProvider, Project } from '@/types/app';
import { SETTINGS_MAIN_TABS } from '@/components/settings/constants/constants';
import { preview } from '@/components/engram-row';
import { TypeBadge } from '@/shared/view/ui/EngramType';

import {
  collectSessions,
  currentProjectFirst,
  detectMac,
  folderName,
  matchesWords,
  queryWords,
} from './paletteSearch';

type PalettePage = 'projects' | 'sessions' | 'tasks';

interface CommandPaletteProps {
  projects: Project[];
  selectedProject: Project | null;
  onStartNewChat: (project: Project) => void;
  onOpenSettings: (tab?: string) => void;
  onShowView?: (view: PaneView) => void;
  onOpenSession: (sessionId: string, projectId: string | null) => void;
}

const PAGE_LABEL: Record<PalettePage, string> = {
  projects: 'New session in',
  sessions: 'Sessions',
  tasks: 'Open task',
};

const PAGE_PLACEHOLDER: Record<PalettePage, string> = {
  projects: 'Project…',
  sessions: 'Search sessions…',
  tasks: 'Open a task… search by title, customer or project',
};

const ROOT_PLACEHOLDER = 'Type a command or search…';

const ROOT_LIMIT = 5;
const ROOT_SEARCH_LIMIT = 8;
const SEARCH_MIN_CHARS = 2;
const BRAIN_DEBOUNCE_MS = 200;
const BRAIN_LIMIT = 8;
const HIDDEN_ENGRAM_STATUSES: ReadonlySet<EngramStatus> = new Set(['superseded', 'invalidated']);

const NAV_ENTRIES: ReadonlyArray<{ label: string; keywords: string; icon: LucideIcon; view: PaneView }> = [
  { label: 'Go to Terminal', keywords: 'terminal shell console claude', icon: SquareTerminal, view: 'terminal' },
  { label: 'Go to Brain', keywords: 'brain engrams timeline graph', icon: Brain, view: 'brain' },
  { label: 'Go to Notes', keywords: 'note notes todo checklist', icon: NotebookPen, view: 'note' },
  { label: 'Go to Worktrees', keywords: 'worktrees worktree branch git ports', icon: FolderGit2, view: 'worktrees' },
  { label: 'Go to Repository', keywords: 'repository repo changes diff code files commits review git', icon: FileDiff, view: 'repository' },
  { label: 'Go to Time', keywords: 'time tracking clock hours work timesheet', icon: Clock, view: 'time' },
  { label: 'Go to Shell', keywords: 'shell terminal console zsh bash command line', icon: SquareTerminal, view: 'shell' },
];

const IS_MAC = detectMac();
const NEW_SESSION_HINT = IS_MAC ? '⌘⇧K' : 'Ctrl+Shift+K';

function PaletteRow({
  value,
  onSelect,
  icon,
  label,
  muted = false,
  aside,
}: {
  value: string;
  onSelect: () => void;
  icon: ReactNode;
  label: string;
  muted?: boolean;
  aside?: ReactNode;
}) {
  return (
    <CommandItem value={value} onSelect={onSelect}>
      <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className={muted ? 'min-w-0 flex-1 truncate text-muted-foreground' : 'min-w-0 flex-1 truncate'}>
        {label}
      </span>
      {aside}
    </CommandItem>
  );
}

/** An open task: its state dot, its title, where it is now, and what Enter does with it. */
function TaskRow({ task, where, projectName, onSelect }: { task: BoardTask; where: TaskLocation; projectName: string; onSelect: () => void }) {
  const state = taskState(task);
  const words = locationWords(where);
  return (
    <CommandItem value={`task ${task.spaceId} ${task.id}`} onSelect={onSelect} className="items-start py-1.5">
      <span className="flex h-(--target-min) shrink-0 items-center"><Dot hue={state.hue} hollow={state.hollow} /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{taskName(task)}</span>
        <span className="truncate text-caption text-muted-foreground">{[projectName, state.label, words.text].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 self-center text-caption text-muted-foreground">
        {words.act}
        <kbd className="rounded border border-border px-1 font-code text-caption">↵</kbd>
      </span>
    </CommandItem>
  );
}

const ENDED: Record<string, string> = { resolved: 'Done', invalidated: 'Dropped', superseded: 'Replaced' };
const closedDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '');

/** A closed task: how and when it ended; Enter opens its panel on the task board, where Reopen is. */
function ClosedTaskRow({ task, projectName, onSelect }: { task: BoardTask; projectName: string; onSelect: () => void }) {
  return (
    <CommandItem value={`task ${task.spaceId} ${task.id}`} onSelect={onSelect} className="items-start py-1.5">
      <span className="flex h-(--target-min) shrink-0 items-center"><Dot hue="done" hollow /></span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium text-muted-foreground">{taskName(task)}</span>
        <span className="truncate text-caption text-muted-foreground">{[projectName, `${ENDED[task.status] ?? 'Closed'} ${closedDay(task.closedAt)}`.trim(), task.outcome].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="flex shrink-0 items-center gap-1.5 self-center text-caption text-muted-foreground">
        Open task
        <kbd className="rounded border border-border px-1 font-code text-caption">↵</kbd>
      </span>
    </CommandItem>
  );
}

function AsideText({ children }: { children: ReactNode }) {
  return <span className="max-w-48 shrink-0 truncate text-caption text-muted-foreground">{children}</span>;
}

export default function CommandPalette({
  projects,
  selectedProject,
  onStartNewChat,
  onOpenSettings,
  onShowView,
  onOpenSession,
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [pages, setPages] = useState<PalettePage[]>([]);
  const [chosenProvider, setChosenProvider] = useState<LLMProvider | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [heldBrain, setHeldBrain] = useState<Engram[] | null>(null);
  // Open task: the project the search keeps to (the tasks card's "more open tasks in …"), and whether the
  // Enter that picked a row held ⌘/Ctrl (open in a new desk).
  const [taskProject, setTaskProject] = useState<string | null>(null);
  const newDeskRef = useRef(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const escapeGoesBackRef = useRef(false);

  const { toggleDarkMode } = useTheme();
  const desks = useDesks();
  const spaces = useSpaces();
  const { data: providers } = useProviders();
  const viewEnabled = useViewEnabled();
  const engramPanel = useEngramPanel();

  const page: PalettePage | null = pages.length > 0 ? pages[pages.length - 1] : null;
  const query = search.trim();
  const words = useMemo(() => queryWords(query), [query]);
  const searchMode = query.length >= SEARCH_MIN_CHARS;
  const rootLimit = searchMode ? ROOT_SEARCH_LIMIT : ROOT_LIMIT;

  const resetState = useCallback(() => {
    setSearch('');
    setPages([]);
    setChosenProvider(null);
    setTaskProject(null);
  }, []);

  // Opened from the nav's Search tasks, the tasks card's Open task… or its "more open tasks in …" link.
  useEffect(() => {
    const onOpen = (event: Event) => {
      const project = (event as CustomEvent<{ project?: string | null }>).detail?.project ?? null;
      setChosenProvider(null);
      setSearch('');
      setTaskProject(project);
      setPages(['tasks']);
      setOpen(true);
    };
    window.addEventListener(TASK_SEARCH_EVENT, onOpen);
    return () => window.removeEventListener(TASK_SEARCH_EVENT, onOpen);
  }, []);

  const closePalette = useCallback(() => {
    setOpen(false);
    resetState();
  }, [resetState]);

  const goBack = useCallback(() => {
    setPages((stack) => stack.slice(0, -1));
    setSearch('');
  }, []);

  const pushPage = useCallback((next: PalettePage, keepSearch = false) => {
    setPages((stack) => [...stack, next]);
    if (!keepSearch) setSearch('');
  }, []);

  // Global shortcut, capture phase so a focused terminal cannot swallow it.
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const modifier = IS_MAC ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      if (event.shiftKey) {
        setChosenProvider(null);
        setSearch('');
        setPages(['projects']);
        setOpen(true);
        return;
      }
      setOpen((wasOpen) => !wasOpen);
      resetState();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [resetState]);

  // The input gets focus on open and on every page change. Scheduled after
  // the dialog's own first-focusable focus, which would otherwise pick the
  // page pill's Back button.
  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open, page]);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setOpen(true);
        return;
      }
      if (escapeGoesBackRef.current) {
        escapeGoesBackRef.current = false;
        goBack();
        return;
      }
      closePalette();
    },
    [closePalette, goBack],
  );

  const handleEscape = useCallback(() => {
    escapeGoesBackRef.current = pages.length > 0;
  }, [pages.length]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') newDeskRef.current = IS_MAC ? event.metaKey : event.ctrlKey;
    if (event.key === 'Backspace' && search === '' && pages.length > 0) {
      event.preventDefault();
      goBack();
    }
  };

  const run = (action: () => void) => {
    closePalette();
    action();
  };

  // ── Brain search ────────────────────────────────────────────────────
  const brainActive = open && page === null && searchMode;
  if (!brainActive && debouncedQuery !== '') setDebouncedQuery('');

  useEffect(() => {
    if (!brainActive) return;
    const timer = window.setTimeout(() => setDebouncedQuery(query), BRAIN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [brainActive, query]);

  const brainEnabled = brainActive && debouncedQuery.length >= SEARCH_MIN_CHARS;
  const brainList = useList({ search: debouncedQuery, limit: BRAIN_LIMIT }, brainEnabled);
  const freshBrain = brainEnabled ? brainList.data?.engrams : undefined;

  // Remember the last result set so it stays on screen while the next one loads.
  if (freshBrain && freshBrain !== heldBrain) setHeldBrain(freshBrain);
  if (!brainActive && heldBrain !== null) setHeldBrain(null);

  const brainLoading = brainActive && (query !== debouncedQuery || (brainEnabled && brainList.isFetching));
  const brainSource = freshBrain ?? (brainLoading ? heldBrain : null) ?? [];
  const brainRows = brainActive ? brainSource.filter((e) => !HIDDEN_ENGRAM_STATUSES.has(e.status)) : [];

  // ── Sessions ────────────────────────────────────────────────────────
  const allSessions = useMemo(() => collectSessions(projects), [projects]);
  const matchingSessions = useMemo(
    () => allSessions.filter((s) => matchesWords(words, s.label, s.projectName, s.id)),
    [allSessions, words],
  );
  const showSessions = page === null || page === 'sessions';
  const shownSessions = page === null ? matchingSessions.slice(0, rootLimit) : matchingSessions;

  // ── Projects ────────────────────────────────────────────────────────
  const orderedProjects = useMemo(
    () => currentProjectFirst(projects, selectedProject?.projectId ?? null),
    [projects, selectedProject?.projectId],
  );
  const matchingProjects = useMemo(
    () => orderedProjects.filter((p) => matchesWords(words, p.displayName, folderName(p.fullPath))),
    [orderedProjects, words],
  );
  const showProjects = page === null || page === 'projects';
  const shownProjects = page === null ? matchingProjects.slice(0, rootLimit) : matchingProjects;

  const readyProviders = (providers ?? []).filter((p) => p.version !== null);
  const providerOnPage = page === 'projects' ? chosenProvider : null;
  const providerLabel = providerOnPage ? readyProviders.find((p) => p.id === providerOnPage)?.label : undefined;
  const projectHint = providerLabel ? `New ${providerLabel} session` : 'New session';

  const selectProject = (project: Project) => {
    const provider = providerOnPage;
    run(() => {
      if (provider) openInPane({ surface: 'terminal', projectId: project.projectId, provider });
      else onStartNewChat(project);
    });
  };

  // ── Open tasks (root and the Open task page) ────────────────────────
  const { data: board } = useTaskBoard();
  const { sessions: liveSessions } = useAllSessions(open);
  const activeDeskId = useActiveDeskId();
  const activeSpaceKey = useActiveSpaceId();
  const showTasks = page === null || page === 'tasks';
  const taskGroups = useMemo(() => (showTasks && board ? searchTasks(board, query, page === 'tasks' && taskProject ? { project: taskProject } : {}) : []), [showTasks, board, query, page, taskProject]);
  const locate = (task: BoardTask) => locateTask(task, {
    activeDeskId,
    desks: desks.map((d) => ({ id: d.id, name: d.name, spaceId: d.spaceId, panes: d.panes })),
    sessions: (liveSessions ?? []).filter((s) => !s.archivedAt).map((s) => ({ id: s.id, lastActivity: s.lastActivity ?? null, projectId: s.projectId ?? null })),
    spaces: spaces.map((s) => ({ id: s.id, name: s.name, key: paneSpaceKey(s) })),
    activeSpaceKey,
  });
  const taskLimit = page === 'tasks' ? Infinity : searchMode ? ROOT_SEARCH_LIMIT : ROOT_LIMIT;
  const shownTaskGroups = taskGroups.map((g) => ({ ...g, tasks: g.tasks.slice(0, taskLimit) }));
  const taskCount = taskGroups.reduce((n, g) => n + g.tasks.length, 0);
  const taskBrowseLabel = page === null && taskCount > shownTaskGroups.reduce((n, g) => n + g.tasks.length, 0) ? `All ${taskCount} tasks…` : null;
  const pickTask = (task: BoardTask) => {
    const newDesk = newDeskRef.current;
    newDeskRef.current = false;
    const where = locate(task);
    run(() => { void openTask(task, where, { newDesk }); });
  };
  // A closed task opens in the task board's panel, where it can be reopened; nothing starts.
  const pickClosedTask = (task: BoardTask) => {
    newDeskRef.current = false;
    run(() => { requestTaskPanel(task.id); setTopView('tasks'); });
  };
  const activeDeskName = desks.find((d) => d.id === activeDeskId)?.name ?? 'this desk';

  // ── Actions / Navigate / Settings (root only) ───────────────────────
  type ActionEntry = { label: string; icon: LucideIcon; hint?: string; onSelect: () => void };
  const actions: ActionEntry[] = [];
  if (page === null) {
    actions.push({
      label: 'New session in…',
      icon: MessageSquarePlus,
      hint: NEW_SESSION_HINT,
      onSelect: () => {
        setChosenProvider(null);
        pushPage('projects');
      },
    });
    if (readyProviders.length > 1) {
      for (const provider of readyProviders) {
        actions.push({
          label: `New ${provider.label} session in…`,
          icon: MessageSquarePlus,
          onSelect: () => {
            setChosenProvider(provider.id);
            pushPage('projects');
          },
        });
      }
    }
    // Every shortcut is here too, with its keys (top-bar/shortcuts.ts).
    const hint = (label: string) => keysHint(SHORTCUTS.find((s) => s.label === label)?.keys ?? []);
    actions.push(
      { label: 'Open the Inbox', icon: Inbox, hint: hint('Open the Inbox from anywhere'), onSelect: () => run(() => openTaskView('inbox')) },
      { label: 'Tasks: Inbox', icon: ListChecks, hint: hint('Inbox'), onSelect: () => run(() => openTaskView('inbox')) },
      { label: 'Tasks: Now', icon: ListChecks, hint: hint('Now'), onSelect: () => run(() => openTaskView('now')) },
      { label: 'Tasks: Plan', icon: ListChecks, hint: hint('Plan'), onSelect: () => run(() => openTaskView('plan')) },
      { label: 'Jobs', icon: CalendarClock, onSelect: () => run(() => setTopView('jobs')) },
      { label: 'Open settings', icon: SettingsIcon, hint: hint('Settings'), onSelect: () => run(() => onOpenSettings()) },
      { label: 'Keyboard shortcuts', icon: Keyboard, hint: hint('This list of shortcuts'), onSelect: () => run(() => setShortcutSheet(true)) },
      { label: 'Toggle theme', icon: SunMoon, onSelect: () => run(toggleDarkMode) },
    );
    orderedDesks(desks, spaces).forEach((desk, i) => {
      const space = spaces.find((sp) => paneSpaceKey(sp) === desk.spaceId);
      actions.push({
        label: `Go to ${space ? `${space.name} · ` : ''}${desk.name}`,
        icon: LayoutGrid,
        hint: i < 9 ? `${MOD} ${i + 1}` : undefined,
        onSelect: () => run(() => { setTopView('desks'); activateDesk(desk.id); }),
      });
    });
  }
  const shownActions = actions.filter((a) => matchesWords(words, a.label));
  const shownNav = page === null ? NAV_ENTRIES.filter((n) => viewEnabled(n.view) && matchesWords(words, n.label, n.keywords)) : [];
  const shownSettings =
    page === null ? SETTINGS_MAIN_TABS.filter((t) => matchesWords(words, 'Settings', t.label, t.keywords)) : [];

  const sessionBrowseRow =
    page !== null
      ? null
      : query === ''
        ? allSessions.length > ROOT_LIMIT
          ? { label: `Browse all ${allSessions.length} sessions…`, keepSearch: false }
          : null
        : matchingSessions.length > shownSessions.length
          ? { label: `Show all ${matchingSessions.length} matching sessions…`, keepSearch: true }
          : null;
  const projectBrowseLabel =
    page === null && query === '' && projects.length > ROOT_LIMIT ? `Browse all ${projects.length} projects…` : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden p-0" onEscapeKeyDown={handleEscape}>
        <DialogTitle>Command palette</DialogTitle>
        <Command label="Command palette" shouldFilter={false} onKeyDown={handleKeyDown}>
          {page && (
            <div className="flex items-center border-b border-border px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-muted pr-0.5 pl-2.5 text-caption font-medium text-foreground">
                {PAGE_LABEL[page]}
                <button
                  type="button"
                  aria-label="Back"
                  onClick={goBack}
                  className="inline-flex size-(--target-min) items-center justify-center rounded-full text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring"
                >
                  <X aria-hidden className="size-3" />
                </button>
              </span>
            </div>
          )}
          <CommandInput
            ref={inputRef}
            value={search}
            onValueChange={setSearch}
            placeholder={page ? PAGE_PLACEHOLDER[page] : ROOT_PLACEHOLDER}
          />
          <CommandList>
            {!brainLoading && <CommandEmpty>{page === 'tasks' ? 'No task matches. New tasks come from a chat or the New task bar.' : 'No results found.'}</CommandEmpty>}

            {shownTaskGroups.map((group) => (
              <CommandGroup key={group.name} heading={page === 'tasks' && taskProject ? `${group.name} · ${board?.projects.find((p) => p.id === taskProject)?.name ?? readable(taskProject)}` : group.name}>
                {group.tasks.map((task) => (group.closed
                  ? <ClosedTaskRow key={`${task.spaceId}:${task.id}`} task={task} projectName={board ? projectNameOf(board, task) : ''} onSelect={() => pickClosedTask(task)} />
                  : <TaskRow key={`${task.spaceId}:${task.id}`} task={task} where={locate(task)} projectName={board ? projectNameOf(board, task) : ''} onSelect={() => pickTask(task)} />
                ))}
              </CommandGroup>
            ))}
            {taskBrowseLabel && (
              <CommandGroup>
                <PaletteRow value={taskBrowseLabel} onSelect={() => pushPage('tasks', true)} icon={<ChevronRight className="size-4" />} label={taskBrowseLabel} muted />
              </CommandGroup>
            )}

            {showSessions && shownSessions.length > 0 && (
              <CommandGroup heading="Sessions">
                {shownSessions.map((session) => (
                  <PaletteRow
                    key={`${session.projectId}:${session.id}`}
                    value={`${session.label} ${session.projectName} ${session.id}`.trim()}
                    onSelect={() => run(() => onOpenSession(session.id, session.projectId))}
                    icon={<MessageSquare className="size-4" />}
                    label={session.label}
                    aside={session.projectName ? <AsideText>{session.projectName}</AsideText> : undefined}
                  />
                ))}
                {sessionBrowseRow && (
                  <PaletteRow
                    value={sessionBrowseRow.label}
                    onSelect={() => pushPage('sessions', sessionBrowseRow.keepSearch)}
                    icon={<ChevronRight className="size-4" />}
                    label={sessionBrowseRow.label}
                    muted
                  />
                )}
              </CommandGroup>
            )}

            {showProjects && shownProjects.length > 0 && (
              <CommandGroup heading="Projects">
                {shownProjects.map((project) => (
                  <PaletteRow
                    key={project.projectId}
                    value={`${project.displayName} ${project.projectId}`}
                    onSelect={() => selectProject(project)}
                    icon={<Folder className="size-4" />}
                    label={project.displayName}
                    aside={<AsideText>{projectHint}</AsideText>}
                  />
                ))}
                {projectBrowseLabel && (
                  <PaletteRow
                    value={projectBrowseLabel}
                    onSelect={() => pushPage('projects')}
                    icon={<ChevronRight className="size-4" />}
                    label={projectBrowseLabel}
                    muted
                  />
                )}
              </CommandGroup>
            )}

            {brainRows.length > 0 && (
              <CommandGroup heading="Brain">
                {brainRows.map((engram) => {
                  const line = preview(engram);
                  return (
                    <CommandItem
                      key={engram.id}
                      value={`${line} ${engram.id}`}
                      onSelect={() => {
                        const siblings = brainRows.map((e) => e.id);
                        run(() => engramPanel.open(engram.id, siblings));
                      }}
                    >
                      <span className="shrink-0">
                        <TypeBadge type={engram.type} />
                      </span>
                      <span className="min-w-0 flex-1 truncate">{line}</span>
                      <AsideText>{engram.scope}</AsideText>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}

            {shownActions.length > 0 && (
              <CommandGroup heading="Actions">
                {shownActions.map((action) => {
                  const Icon = action.icon;
                  return (
                    <PaletteRow
                      key={action.label}
                      value={action.label}
                      onSelect={action.onSelect}
                      icon={<Icon className="size-4" />}
                      label={action.label}
                      aside={
                        action.hint ? (
                          <span className="shrink-0 font-code text-caption text-muted-foreground">{action.hint}</span>
                        ) : undefined
                      }
                    />
                  );
                })}
              </CommandGroup>
            )}

            {shownNav.length > 0 && (
              <CommandGroup heading="Navigate">
                {shownNav.map((entry) => {
                  const Icon = entry.icon;
                  return (
                    <PaletteRow
                      key={entry.view}
                      value={`${entry.label} ${entry.keywords}`}
                      onSelect={() => run(() => onShowView?.(entry.view))}
                      icon={<Icon className="size-4" />}
                      label={entry.label}
                    />
                  );
                })}
              </CommandGroup>
            )}

            {shownSettings.length > 0 && (
              <CommandGroup heading="Settings">
                {shownSettings.map((tab) => {
                  const Icon = tab.icon;
                  return (
                    <PaletteRow
                      key={tab.id}
                      value={`Settings ${tab.label} ${tab.keywords}`}
                      onSelect={() => run(() => onOpenSettings(tab.id))}
                      icon={<Icon className="size-4" />}
                      label={`Settings: ${tab.label}`}
                    />
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
          {shownTaskGroups.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-border px-3 py-2 text-caption text-muted-foreground">
              <span><kbd className="font-code">↵</kbd> open on {activeDeskName}</span>
              <span><kbd className="font-code">{MOD}↵</kbd> open in a new desk</span>
            </div>
          )}
        </Command>
      </DialogContent>
    </Dialog>
  );
}
