// A project's notes in the sidebar (decision cockpit-notes-pane): the "Notes"
// group below the sessions. A click opens the note in a pane of its own next
// to the active one (never over a running terminal); the dot marks an agent
// edit not seen yet. Rows rename (rewrites the first line) and delete (archives
// the engram) like session rows; old notes fold behind the History toggle.
import { useEffect, useRef, useState } from 'react';
import { Brain, Check, Edit2, NotebookPen, Plus, Terminal, Trash2, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { newSessionEntries, useProviders } from '@/lib/providers';
import { noteAge, parseBrainDate, useArchiveNote, useCreateNote, useRenameNote, useUnseenNotes, type Note } from '@/lib/notes';
import { Button } from '@/shared/view/ui';
import { forgetNoteInPanes, openInPane, openNote, useActivePane } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';

// The project's one "+" (0.15.1): a small menu — new session / note / brain —
// like the pane toolbar's "+", because a terminal pane starts an agent
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

  const terminals: Array<{ label: string; Icon: typeof Terminal; disabled?: string; run: () => void }> =
    newSessionEntries(useProviders().data ?? []).map(({ label, provider }) => ({
      label,
      Icon: Terminal,
      run: provider
        ? () => openInPane({ surface: 'terminal', projectId: project.projectId, provider })
        : () => onNewSession(project),
    }));
  const items: Array<{ label: string; Icon: typeof Terminal; disabled?: string; run: () => void }> = [
    ...terminals,
    {
      label: 'New brain view',
      Icon: Brain,
      disabled: inBrain ? undefined : 'This project exists only as a folder — it has no brain view',
      run: () => openInPane({ surface: 'brain', projectId: project.projectId }),
    },
    {
      label: 'New note',
      Icon: NotebookPen,
      disabled: inBrain ? undefined : 'Notes need a brain project — this project exists only as a folder',
      run: () => create.mutate(project.projectId, { onSuccess: (note) => openNote(note.id, project.projectId) }),
    },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        className={cn(
          'flex h-6 w-6 flex-shrink-0 items-center justify-center rounded text-primary transition-colors hover:bg-primary/10',
          open && 'bg-primary/10',
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
        <Plus className="h-3.5 w-3.5" />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute top-full left-0 z-40 mt-1 min-w-[10rem] whitespace-nowrap rounded-md border border-foreground/20 bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,0.14)] ring-1 dark:shadow-[0_8px_24px_rgba(0,0,0,0.6)] ring-black/5 dark:ring-black/40"
        >
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
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-ui text-foreground transition-colors hover:bg-foreground/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <Icon className="h-3.5 w-3.5 text-foreground/80" strokeWidth={1.8} />
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Hover actions, same chip as session rows (SidebarSessionItem ROW_ACTION).
const ROW_ACTION =
  'flex h-6 w-6 items-center justify-center rounded border border-border bg-background text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground';

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

export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

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
        <div key={note.id} className={cn(oldNoteIds.has(note.id) && 'opacity-60')}>
          <SidebarNoteItem project={project} note={note} currentTime={currentTime} />
        </div>
      ))}
    </div>
  );
}

// The small caps label over a project's sessions and notes groups.
export function SidebarGroupLabel({ children }: { children: string }) {
  return <div className="px-2 pt-1 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{children}</div>;
}

function SidebarNoteItem({ project, note, currentTime }: { project: Project; note: Note; currentTime: Date }) {
  const unseen = useUnseenNotes();
  const activePane = useActivePane();
  const rename = useRenameNote();
  const archive = useArchiveNote();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const isSelected = activePane?.paneView === 'note' && activePane.noteId === note.id;

  const save = () => {
    const title = draft.trim();
    setEditing(false);
    if (title && title !== note.title) rename.mutate({ id: note.id, title });
  };

  return (
    <div className={cn('group relative', archive.isPending && 'pointer-events-none opacity-50')}>
      <Button
        variant="ghost"
        className={cn(
          'h-7.5 w-full justify-start px-2 py-0 text-left font-normal transition-colors duration-200 hover:bg-accent/50',
          isSelected && 'bg-accent text-accent-foreground',
        )}
        onClick={() => openNote(note.id, project.projectId)}
        title={note.title}
      >
        <div className="flex w-full min-w-0 items-center gap-2 group-hover:pr-[56px]">
          <NotebookPen className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{note.title}</span>
          {unseen.has(note.id) && (
            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-primary" title="Changed by the agent" />
          )}
          <span className="flex-shrink-0 text-[11px] text-muted-foreground group-hover:hidden">
            {noteAge(note.updatedAt, currentTime)}
          </span>
        </div>
      </Button>

      <div className="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 opacity-0 transition-all duration-200 group-hover:opacity-100">
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
              className="w-32 rounded border border-border bg-background px-2 py-1 text-xs focus:ring-1 focus:ring-primary focus:outline-none"
              autoFocus
            />
            <button className={ROW_ACTION} onClick={(event) => { event.stopPropagation(); save(); }} title="Save">
              <Check className="h-3 w-3" />
            </button>
            <button className={ROW_ACTION} onClick={(event) => { event.stopPropagation(); setEditing(false); }} title="Cancel">
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <>
            <button
              className={ROW_ACTION}
              onClick={(event) => {
                event.stopPropagation();
                setDraft(note.title);
                setEditing(true);
              }}
              title="Rename note"
            >
              <Edit2 className="h-3.5 w-3.5" />
            </button>
            <button
              className={cn(ROW_ACTION, 'hover:border-destructive/60 hover:text-destructive')}
              onClick={(event) => {
                event.stopPropagation();
                archive.mutate(note, { onSuccess: () => forgetNoteInPanes(note.id) });
              }}
              title="Delete note (archived in the brain)"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
