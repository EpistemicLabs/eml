// The `note` pane-type (decision cockpit-notes-pane): one `type=note` engram of
// the pane's brain project, edited like Apple Notes — markdown with checklists,
// saved in place 1.2s after the last keystroke. Agent edits arrive through the
// host's `notes` event: applied at once when nothing local is unsaved, else a
// conflict bar lets the user pick a version. Without a noteId the pane lists
// the project's notes to pick from.
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Markdown } from '@tiptap/markdown';
import { Archive, Bold, Italic, List, ListChecks, ListOrdered, Loader2, NotebookPen, Plus, Strikethrough, type LucideIcon } from 'lucide-react';

import { ApiError } from '@/lib/api';
import {
  NoteConflictError,
  noteAge,
  noteKey,
  notesKey,
  saveNote,
  useArchiveNote,
  useCreateNote,
  useNote,
  useNoteOpen,
  useNotes,
  type Note,
} from '@/lib/notes';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/view/ui';
import { updatePane } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';

import './note-editor.css';

const SAVE_DELAY_MS = 1200;
// The host's content for a note created empty (notes-api.ts NEW_NOTE_CONTENT).
const NEW_NOTE_CONTENT = 'New note';

type NotePaneProps = {
  paneId: string;
  project: Project | null;
  noteId?: string;
};

export function NotePane({ paneId, project, noteId }: NotePaneProps) {
  if (!project?.brainProjectId) {
    return (
      <PaneMessage>
        {project
          ? 'Notes live in the brain — this project exists only as a folder.'
          : 'Pick a project for this pane to see its notes.'}
      </PaneMessage>
    );
  }
  if (!noteId) return <NotePicker paneId={paneId} project={project} />;
  return <NoteEditor key={noteId} paneId={paneId} noteId={noteId} />;
}

function PaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function NotePicker({ paneId, project }: { paneId: string; project: Project }) {
  const notes = useNotes(project.projectId);
  const create = useCreateNote();
  const open = (id: string) => updatePane(paneId, { noteId: id });

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-3 p-4">
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={create.isPending}
        onClick={() => create.mutate(project.projectId, { onSuccess: (note) => open(note.id) })}
      >
        <Plus className="h-3 w-3" /> New note
      </Button>
      {notes.isLoading ? (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      ) : notes.data?.length ? (
        <ul className="flex flex-col">
          {notes.data.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                onClick={() => open(note.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-foreground/5"
              >
                <NotebookPen className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{note.title}</span>
                <span className="text-caption text-muted-foreground">{noteAge(note.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">No notes in {project.displayName} yet.</p>
      )}
    </div>
  );
}

function NoteEditor({ paneId, noteId }: { paneId: string; noteId: string }) {
  const qc = useQueryClient();
  const query = useNote(noteId);
  const archive = useArchiveNote();
  useNoteOpen(noteId);

  // What the editor content is based on; a save is checked against it.
  const baseRef = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const [conflict, setConflict] = useState<Note | null>(null);
  const conflictRef = useRef<Note | null>(null);
  conflictRef.current = conflict;
  const [saveState, setSaveState] = useState<'saved' | 'pending' | 'saving' | 'error'>('saved');

  const flush = useCallback(async (force = false) => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const editor = editorRef.current;
    if (!editor || !dirtyRef.current || savingRef.current) return;
    savingRef.current = true;
    dirtyRef.current = false;
    setSaveState('saving');
    try {
      const saved = await saveNote(noteId, editor.getMarkdown(), force ? null : baseRef.current);
      baseRef.current = saved.rev;
      qc.setQueryData(noteKey(noteId), saved);
      void qc.invalidateQueries({ queryKey: notesKey(saved.projectId) });
      setConflict(null);
      setSaveState(dirtyRef.current ? 'pending' : 'saved');
    } catch (err) {
      dirtyRef.current = true;
      if (err instanceof NoteConflictError) {
        setConflict(err.note);
        setSaveState('pending');
      } else {
        setSaveState('error');
      }
    } finally {
      savingRef.current = false;
    }
    // Typing during the save: save that too.
    if (dirtyRef.current && !timerRef.current && !conflictRef.current) {
      timerRef.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    }
  }, [noteId, qc]);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown,
    ],
    editorProps: { attributes: { class: 'note-editor' } },
    onUpdate: () => {
      dirtyRef.current = true;
      setSaveState('pending');
      if (conflictRef.current) return; // no autosave until the conflict is settled
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
  });
  editorRef.current = editor;

  // First load and every change from outside (agent edit, another tab).
  const note = query.data;
  useEffect(() => {
    if (!editor || !note || note.rev === baseRef.current || savingRef.current) return;
    if (baseRef.current === null) {
      editor.commands.setContent(note.content, { contentType: 'markdown', emitUpdate: false });
      baseRef.current = note.rev;
      // A fresh note's placeholder is selected so typing replaces it.
      if (note.content === NEW_NOTE_CONTENT) editor.chain().focus().selectAll().run();
      else editor.commands.focus('end');
      return;
    }
    if (editor.getMarkdown() === note.content) {
      baseRef.current = note.rev;
    } else if (!dirtyRef.current) {
      editor.commands.setContent(note.content, { contentType: 'markdown', emitUpdate: false });
      baseRef.current = note.rev;
    } else {
      setConflict(note);
    }
  }, [editor, note]);

  // Leaving the note (pane closed, other note picked): save what is pending.
  useEffect(() => () => { void flush(); }, [flush]);

  const takeTheirs = () => {
    if (!editor || !conflict) return;
    editor.commands.setContent(conflict.content, { contentType: 'markdown', emitUpdate: false });
    baseRef.current = conflict.rev;
    dirtyRef.current = false;
    setConflict(null);
    setSaveState('saved');
  };
  const keepMine = () => {
    setConflict(null);
    dirtyRef.current = true;
    void flush(true);
  };

  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <PaneMessage>
        <span>
          This note was archived or no longer exists.{' '}
          <button type="button" className="underline" onClick={() => updatePane(paneId, { noteId: undefined })}>
            Show all notes
          </button>
        </span>
      </PaneMessage>
    );
  }
  if (!note) {
    return <PaneMessage><Loader2 className="h-4 w-4 animate-spin" /></PaneMessage>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 px-3 pb-1 text-caption text-muted-foreground">
        <span>
          {note.lastEditor === 'agent' ? 'Edited by the agent' : 'Edited by you'} · {noteAge(note.updatedAt)}
        </span>
        <span className="opacity-70">
          {saveState === 'saving' ? '· saving…' : saveState === 'pending' ? '· unsaved' : saveState === 'error' ? '· save failed' : ''}
        </span>
        <button
          type="button"
          title="Archive this note"
          className="ml-auto rounded p-1 hover:bg-foreground/5 hover:text-foreground"
          onClick={() => {
            if (timerRef.current) clearTimeout(timerRef.current);
            dirtyRef.current = false;
            archive.mutate(note, { onSuccess: () => updatePane(paneId, { noteId: undefined }) });
          }}
        >
          <Archive className="h-3.5 w-3.5" />
        </button>
      </div>
      <NoteToolbar editor={editor} />
      {conflict && (
        <div className="mx-3 mb-2 flex flex-wrap items-center gap-2 rounded border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <span className="flex-1">
            {conflict.lastEditor === 'agent' ? 'The agent' : 'Someone'} changed this note while you were typing.
          </span>
          <Button variant="outline" size="sm" onClick={takeTheirs}>Load their version</Button>
          <Button variant="outline" size="sm" onClick={keepMine}>Keep mine</Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6" onClick={() => editor?.commands.focus()}>
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

// Slim format bar: checklist, bullet list, bold /
// italic / strikethrough. Markdown shortcuts and TipTap's keys keep working.
type Tool = { label: string; icon: LucideIcon; isActive: (e: Editor) => boolean; run: (e: Editor) => void };

const TOOLS: Tool[][] = [
  [
    { label: 'Checklist', icon: ListChecks, isActive: (e) => e.isActive('taskList'), run: (e) => e.chain().focus().toggleTaskList().run() },
    { label: 'Bullet list', icon: List, isActive: (e) => e.isActive('bulletList'), run: (e) => e.chain().focus().toggleBulletList().run() },
    { label: 'Numbered list', icon: ListOrdered, isActive: (e) => e.isActive('orderedList'), run: (e) => e.chain().focus().toggleOrderedList().run() },
  ],
  [
    { label: 'Bold (⌘B)', icon: Bold, isActive: (e) => e.isActive('bold'), run: (e) => e.chain().focus().toggleBold().run() },
    { label: 'Italic (⌘I)', icon: Italic, isActive: (e) => e.isActive('italic'), run: (e) => e.chain().focus().toggleItalic().run() },
    { label: 'Strikethrough (⌘⇧S)', icon: Strikethrough, isActive: (e) => e.isActive('strike'), run: (e) => e.chain().focus().toggleStrike().run() },
  ],
];

function NoteToolbar({ editor }: { editor: Editor | null }) {
  // Re-render on selection/format changes so the active state follows the cursor.
  const active = useEditorState({
    editor,
    selector: ({ editor: e }) => (e ? TOOLS.flat().map((t) => t.isActive(e)) : []),
  });
  if (!editor) return null;
  let i = 0;
  return (
    <div className="flex flex-shrink-0 items-center gap-0.5 px-3 pb-2">
      {TOOLS.map((group, g) => (
        <div key={g} className={cn('flex items-center gap-0.5', g > 0 && 'ml-1 border-l border-border pl-1.5')}>
          {group.map((tool) => {
            const on = active?.[i++] ?? false;
            const Icon = tool.icon;
            return (
              <button
                key={tool.label}
                type="button"
                title={tool.label}
                aria-label={tool.label}
                aria-pressed={on}
                // Keep the editor's selection: no focus steal on mousedown.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => tool.run(editor)}
                className={cn(
                  'flex h-7 w-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground',
                  on && 'bg-foreground/10 text-foreground',
                )}
              >
                <Icon className="h-4 w-4" />
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
