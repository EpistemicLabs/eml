// A project's notes in the sidebar (decision cockpit-notes-pane): the "Notes"
// group below the sessions. A click opens the note in a pane of its own next
// to the active one (never over a running terminal); the dot marks an agent
// edit not seen yet. Rows rename (rewrites the first line) and delete (archives
// the engram) like session rows; old notes fold behind the History toggle.
import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, Edit2, MoreHorizontal, NotebookPen, Plus, Trash2, X, type LucideIcon } from 'lucide-react';
import { useWritable } from '@/stores/useTeamStore';

import { useLongPress } from '@/hooks/useLongPress';
import { cn } from '@/lib/utils';
import { newSessionEntries, useProviders } from '@/lib/providers';
import { paneViewDef, useViewEnabled } from '@/lib/pane-views';
import { noteAge, parseBrainDate, useArchiveNote, useCreateNote, useRenameNote, useUnseenNotes, type Note } from '@/lib/notes';
import { DAY_MS } from '@/lib/time';
import { FIELD, FOCUS, LABEL, POPOVER, ROW } from '@/shared/view/ui';
import { forgetNoteInPanes, openInPane, openNote, useActivePane } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';
import { useRowMenu } from '../rowMenuContext';
import { CHIP, CHIP_DELETE } from './SidebarParts';

// The project's one "+" (0.15.1): a small menu — the new sessions, then the
// plugins (brain view, and note / worktrees / repository while on) — like the pane
// toolbar's "+", because a terminal pane starts an agent
// session the moment it mounts. ⌥-click skips the menu and starts a session.
// With more than one agent CLI ready, the menu offers a session per CLI
// instead of the one entry for the default (newSessionEntries).
export function NewPaneButton({ project, onNewSession }: { project: Project; onNewSession: (project: Project) => void }) {
  const create = useCreateNote();
  const inBrain = Boolean(project.brainProjectId);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // A shared brain that is not live takes no write (useTeamStore).
  const brain = useWritable(project.__spaceId);
  const enabled = useViewEnabled();
  type Item = { label: string; Icon: LucideIcon; disabled?: string; run: () => void };
  const item = (view: 'brain' | 'note' | 'worktrees' | 'repository', rest: Omit<Item, 'label' | 'Icon'>): Item[] =>
    enabled(view) ? [{ label: paneViewDef(view).newLabel, Icon: paneViewDef(view).icon, ...rest }] : [];
  const sections: Array<{ title: string; items: Item[] }> = [
    {
      title: 'Sessions',
      items: newSessionEntries(useProviders().data ?? []).map(({ label, provider }) => ({
        label,
        Icon: paneViewDef('terminal').icon,
        run: provider
          ? () => openInPane({ surface: 'terminal', projectId: project.projectId, provider })
          : () => onNewSession(project),
      })),
    },
    {
      title: 'Plugins',
      items: [
        ...item('brain', {
          disabled: inBrain ? undefined : 'This project exists only as a folder — it has no brain view',
          run: () => openInPane({ surface: 'brain', projectId: project.projectId }),
        }),
        ...item('note', {
          disabled: inBrain ? brain.reason ?? undefined : 'Notes need a brain project — this project exists only as a folder',
          run: () => create.mutate(project.projectId, { onSuccess: (note) => openNote(note.id, project.projectId) }),
        }),
        ...item('worktrees', {
          disabled: project.path ? undefined : 'Worktrees need the project\'s folder — this project has none',
          run: () => openInPane({ surface: 'worktrees', projectId: project.projectId }),
        }),
        ...item('repository', {
          disabled: project.path ? undefined : 'The repository view needs the project\'s folder — this project has none',
          run: () => openInPane({ surface: 'repository', projectId: project.projectId }),
        }),
      ],
    },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(
          'flex size-(--target-min) flex-shrink-0 items-center justify-center rounded-md text-foreground transition-colors duration-(--duration-fast) hover:bg-muted',
          open && 'bg-muted',
          FOCUS,
        )}
        title="New pane (⌥-click: new session)"
        aria-label="New pane"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          if (event.altKey) {
            setOpen(false);
            onNewSession(project);
          } else {
            setOpen((o) => !o);
          }
        }}
      >
        <Plus aria-hidden className="size-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className={cn(POPOVER, 'absolute top-full left-0 mt-1 min-w-40 whitespace-nowrap')}
        >
          {sections.filter(({ items }) => items.length > 0).map(({ title, items }, index) => (
            <Fragment key={title}>
              <div className={cn(LABEL, 'px-2 pb-0.5', index > 0 ? 'mt-1 border-t border-border pt-1.5' : 'pt-1')}>
                {title}
              </div>
              {items.map(({ label, Icon, disabled, run }) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  disabled={Boolean(disabled)}
                  title={disabled}
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    run();
                  }}
                  className={cn(ROW, 'min-h-(--target-comfortable) text-ui disabled:cursor-not-allowed disabled:text-muted-foreground disabled:hover:bg-transparent')}
                >
                  <Icon aria-hidden className="size-3.5" strokeWidth={1.8} />
                  {label}
                </button>
              ))}
            </Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A note stays in the list while it still matters — open in a pane, changed by
 * an agent and not seen yet, or edited in the last 24h — like sessions do.
 * Everything else folds away behind the project's History toggle.
 */
export function isRecentNote(note: Note, openNoteIds: Set<string>, unseen: Set<string>, now: number): boolean {
  if (openNoteIds.has(note.id) || unseen.has(note.id)) return true;
  const last = parseBrainDate(note.updatedAt).getTime();
  return Number.isFinite(last) && now - last < RECENT_WINDOW_MS;
}

export const RECENT_WINDOW_MS = DAY_MS;

export function SidebarProjectNotes({
  project,
  notes,
  oldNoteIds,
  showOld,
  currentTime,
}: {
  project: Project;
  notes: Note[];
  oldNoteIds: Set<string>;
  showOld: boolean;
  currentTime: Date;
}) {
  const shown = showOld ? notes : notes.filter((n) => !oldNoteIds.has(n.id));
  if (!shown.length) return null;

  return (
    <div className="space-y-0.5">
      <SidebarGroupLabel>Notes</SidebarGroupLabel>
      {shown.map((note) => (
        <div key={note.id}>
          <SidebarNoteItem project={project} note={note} currentTime={currentTime} old={oldNoteIds.has(note.id)} />
        </div>
      ))}
    </div>
  );
}

// The small caps label over a project's sessions and notes groups.
export function SidebarGroupLabel({ children }: { children: string }) {
  return <div className={cn(LABEL, 'px-2 pt-1')}>{children}</div>;
}

/** An old note (behind History) shows its title in the muted text colour, never dimmed. */
function SidebarNoteItem({ project, note, currentTime, old }: { project: Project; note: Note; currentTime: Date; old: boolean }) {
  const unseen = useUnseenNotes();
  const activePane = useActivePane();
  const rename = useRenameNote();
  const archive = useArchiveNote();
  const brain = useWritable(project.__spaceId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isSelected = activePane?.paneView === 'note' && activePane.noteId === note.id;
  const menu = useRowMenu();
  const rowRef = useRef<HTMLDivElement>(null);
  const openMenu = () => menu?.open({ kind: 'note', note, project }, rowRef.current);
  const longPress = useLongPress(openMenu);

  const save = () => {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== note.title) rename.mutate({ id: note.id, title });
  };

  return (
    <div ref={rowRef} className={cn('group relative', archive.isPending && 'pointer-events-none opacity-50')} {...(menu ? longPress : {})}>
      <button
        type="button"
        className={cn(
          ROW,
          'justify-start py-0 font-normal transition-colors duration-(--duration-fast)',
          menu ? 'h-10 pr-10' : 'h-7.5',
          isSelected && 'bg-muted',
        )}
        onClick={() => openNote(note.id, project.projectId)}
        title={note.title}
      >
        <div className={cn('flex w-full min-w-0 items-center gap-2', !menu && 'group-hover:pr-14')}>
          <NotebookPen aria-hidden className="size-3 flex-shrink-0 text-muted-foreground" />
          <span className={cn('min-w-0 flex-1 truncate text-ui font-medium', old ? 'text-muted-foreground' : 'text-foreground')}>{note.title}</span>
          {unseen.has(note.id) && (
            <span className="size-1.5 flex-shrink-0 rounded-full bg-mark" title="Changed by the agent" />
          )}
          <span className={cn('flex-shrink-0 text-caption text-muted-foreground tabular-nums', !menu && 'group-hover:hidden')}>
            {noteAge(note.updatedAt, currentTime)}
          </span>
        </div>
      </button>

      {menu ? (
        <button
          type="button"
          aria-label={`Actions for ${note.title}`}
          className={cn('absolute top-0 right-0 flex size-10 items-center justify-center rounded-md text-muted-foreground active:text-foreground', FOCUS)}
          onClick={openMenu}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      ) : (
      <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-opacity duration-(--duration-fast) group-focus-within:opacity-100 group-hover:opacity-100">
        {editing ? (
          <>
            <input
              type="text"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') save();
                else if (event.key === 'Escape') setEditing(false);
              }}
              onClick={(event) => event.stopPropagation()}
              aria-label="Note title"
              className={cn(FIELD, 'min-h-(--target-min) w-32 rounded-md px-2 text-ui')}
              autoFocus
            />
            <button className={cn(CHIP, 'bg-muted text-foreground')} onClick={(event) => { event.stopPropagation(); save(); }} title="Save">
              <Check className="size-3" />
            </button>
            <button className={CHIP} onClick={(event) => { event.stopPropagation(); setEditing(false); }} title="Cancel">
              <X className="size-3" />
            </button>
          </>
        ) : (
          <>
            <button
              className={CHIP}
              disabled={!brain.writable}
              onClick={(event) => {
                event.stopPropagation();
                setDraft(note.title);
                setEditing(true);
              }}
              title={brain.reason ?? 'Rename note'}
            >
              <Edit2 className="size-3.5" />
            </button>
            <button
              className={cn(CHIP, CHIP_DELETE)}
              disabled={!brain.writable}
              onClick={(event) => {
                event.stopPropagation();
                archive.mutate(note, { onSuccess: () => forgetNoteInPanes(note.id) });
              }}
              title={brain.reason ?? 'Delete note (archived in the brain)'}
            >
              <Trash2 className="size-3.5" />
            </button>
          </>
        )}
      </div>
      )}
    </div>
  );
}
