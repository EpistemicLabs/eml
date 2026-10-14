// Cmd/Ctrl+K command palette: jump to sessions, projects and brain engrams,
// start new sessions, switch the active pane's view and open Settings tabs.
// Filtering and ordering happen here; cmdk only handles highlight + keys.
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ChevronRight,
  Brain,
  Folder,
  MessageSquare,
  MessageSquarePlus,
  NotebookPen,
  Settings as SettingsIcon,
  SquareTerminal,
  SunMoon,
  X,
  type LucideIcon,
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
import { useProviders } from '@/lib/providers';
import { useList } from '@/lib/queries';
import { useEngramPanel } from '@/lib/engram-panel';
import type { Engram, EngramStatus } from '@/lib/types';
import { openInPane, type PaneView } from '@/stores/usePaneStore';
import type { LLMProvider, Project } from '@/types/app';
import { SETTINGS_MAIN_TABS } from '@/components/settings/constants/constants';
import { TypeBadge } from '@/components/ui/badge';
import { preview } from '@/components/engram-row';

import {
  collectSessions,
  currentProjectFirst,
  detectMac,
  folderName,
  matchesWords,
  queryWords,
} from './paletteSearch';

type PalettePage = 'projects' | 'sessions';

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
};

const PAGE_PLACEHOLDER: Record<PalettePage, string> = {
  projects: 'Project…',
  sessions: 'Search sessions…',
};

const ROOT_PLACEHOLDER = 'Type a command or search…';

const ROOT_LIMIT = 5;
const ROOT_SEARCH_LIMIT = 8;
const SEARCH_MIN_CHARS = 2;
const BRAIN_DEBOUNCE_MS = 200;
const BRAIN_LIMIT = 8;
const HIDDEN_ENGRAM_STATUSES: ReadonlySet<EngramStatus> = new Set(['superseded', 'invalidated', 'expired']);

const NAV_ENTRIES: ReadonlyArray<{ label: string; keywords: string; icon: LucideIcon; view: PaneView }> = [
  { label: 'Go to Terminal', keywords: 'terminal shell console claude', icon: SquareTerminal, view: 'terminal' },
  { label: 'Go to Brain', keywords: 'brain engrams timeline graph', icon: Brain, view: 'brain' },
  { label: 'Go to Notes', keywords: 'note notes todo checklist', icon: NotebookPen, view: 'note' },
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
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className={muted ? 'min-w-0 flex-1 truncate text-muted-foreground' : 'min-w-0 flex-1 truncate'}>
        {label}
      </span>
      {aside}
    </CommandItem>
  );
}

function AsideText({ children }: { children: ReactNode }) {
  return <span className="max-w-48 shrink-0 truncate text-[11px] text-foreground/45">{children}</span>;
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

  const inputRef = useRef<HTMLInputElement | null>(null);
  const escapeGoesBackRef = useRef(false);

  const { toggleDarkMode } = useTheme();
  const { data: providers } = useProviders();
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
    actions.push(
      { label: 'Open settings', icon: SettingsIcon, onSelect: () => run(() => onOpenSettings()) },
      { label: 'Toggle theme', icon: SunMoon, onSelect: () => run(toggleDarkMode) },
    );
  }
  const shownActions = actions.filter((a) => matchesWords(words, a.label));
  const shownNav = page === null ? NAV_ENTRIES.filter((n) => matchesWords(words, n.label, n.keywords)) : [];
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
            <div className="flex items-center border-b border-foreground/10 px-3 py-2">
              <span className="inline-flex items-center gap-1 rounded-full bg-foreground/5 py-0.5 pr-1 pl-2.5 text-[11px] font-medium text-foreground/70">
                {PAGE_LABEL[page]}
                <button
                  type="button"
                  aria-label="Back"
                  onClick={goBack}
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full opacity-50 transition-opacity hover:opacity-100"
                >
                  <X aria-hidden className="h-3 w-3" />
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
            {!brainLoading && <CommandEmpty>No results found.</CommandEmpty>}

            {showSessions && shownSessions.length > 0 && (
              <CommandGroup heading="Sessions">
                {shownSessions.map((session) => (
                  <PaletteRow
                    key={`${session.projectId}:${session.id}`}
                    value={`${session.label} ${session.projectName} ${session.id}`.trim()}
                    onSelect={() => run(() => onOpenSession(session.id, session.projectId))}
                    icon={<MessageSquare className="h-4 w-4" />}
                    label={session.label}
                    aside={session.projectName ? <AsideText>{session.projectName}</AsideText> : undefined}
                  />
                ))}
                {sessionBrowseRow && (
                  <PaletteRow
                    value={sessionBrowseRow.label}
                    onSelect={() => pushPage('sessions', sessionBrowseRow.keepSearch)}
                    icon={<ChevronRight className="h-4 w-4" />}
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
                    icon={<Folder className="h-4 w-4" />}
                    label={project.displayName}
                    aside={<AsideText>{projectHint}</AsideText>}
                  />
                ))}
                {projectBrowseLabel && (
                  <PaletteRow
                    value={projectBrowseLabel}
                    onSelect={() => pushPage('projects')}
                    icon={<ChevronRight className="h-4 w-4" />}
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
                      icon={<Icon className="h-4 w-4" />}
                      label={action.label}
                      aside={
                        action.hint ? (
                          <span className="shrink-0 text-[11px] text-muted-foreground">{action.hint}</span>
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
                      icon={<Icon className="h-4 w-4" />}
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
                      icon={<Icon className="h-4 w-4" />}
                      label={`Settings: ${tab.label}`}
                    />
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
