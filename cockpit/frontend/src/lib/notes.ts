// Notes (decision cockpit-notes-pane): client for the host's /api/notes routes
// plus the live sync from the `notes` event. The pane never talks to the brain
// directly — these routes are the capabilities a notes plugin would declare.
import { useEffect, useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getActiveSpaceId } from '@/stores/usePaneStore';
import { ApiError } from './api';

export type Note = {
  id: string;
  projectId: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  /** The engram's revision counter: what a save is checked against. */
  rev: number;
  /** Who wrote the current content: the user in a note pane, or an agent. */
  lastEditor: 'user' | 'agent';
};

export type NotesChange = {
  changed: Array<{ id: string; projectId: string; rev: number | null; lastEditor: 'user' | 'agent' | null }>;
};

/** 409 from PUT: someone else wrote since `baseRev`; carries their version of the note. */
export class NoteConflictError extends ApiError {
  constructor(public note: Note) {
    super(409, 'The note changed since you opened it');
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/notes${path}`, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (res.status === 409 && data?.note) throw new NoteConflictError(data.note as Note);
  if (!res.ok) throw new ApiError(res.status, data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

export const notesKey = (projectId: string | null) => ['notes', projectId] as const;
export const noteKey = (id: string | null | undefined) => ['note', id] as const;

export function useNotes(projectId: string | null, enabled = true) {
  return useQuery({
    queryKey: notesKey(projectId),
    queryFn: () => request<{ notes: Note[] }>(`?projectId=${encodeURIComponent(projectId ?? '')}`).then((r) => r.notes),
    enabled: enabled && Boolean(projectId),
  });
}

export function useNote(id: string | null | undefined) {
  return useQuery({
    queryKey: noteKey(id),
    queryFn: () => request<{ note: Note }>(`/${encodeURIComponent(id ?? '')}`).then((r) => r.note),
    enabled: Boolean(id),
    retry: (count, err) => !(err instanceof ApiError && err.status === 404) && count < 2,
  });
}

export function useCreateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      request<{ note: Note }>('', { method: 'POST', body: JSON.stringify({ projectId }) }).then((r) => r.note),
    onSuccess: (note) => {
      qc.setQueryData(noteKey(note.id), note);
      void qc.invalidateQueries({ queryKey: notesKey(note.projectId) });
    },
  });
}

/** `baseRev` null overwrites whatever is there (keep mine after a conflict). */
export function saveNote(id: string, content: string, baseRev: number | null): Promise<Note> {
  return request<{ note: Note }>(`/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ content, baseRev }),
  }).then((r) => r.note);
}

/**
 * A note's title is its first non-empty line (host noteTitle). Renaming
 * rewrites that line's text and keeps its markdown marker (`# `, `- [ ] `), so
 * the title stays one source of truth.
 */
export function retitleContent(content: string, title: string): string {
  const lines = content.split('\n');
  const at = lines.findIndex((l) => l.trim());
  if (at === -1) return title;
  const marker = /^\s*(#{1,6}\s+|[-*+]\s+(\[[ xX]\]\s+)?)?/.exec(lines[at])?.[0] ?? '';
  lines[at] = marker + title;
  return lines.join('\n');
}

export function useRenameNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, title }: { id: string; title: string }) => {
      // Rename against the latest content, checked like any pane save.
      const { note } = await request<{ note: Note }>(`/${encodeURIComponent(id)}`);
      return saveNote(id, retitleContent(note.content, title), note.rev);
    },
    onSuccess: (note) => {
      qc.setQueryData(noteKey(note.id), note);
      void qc.invalidateQueries({ queryKey: notesKey(note.projectId) });
    },
  });
}

export function useArchiveNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (note: Pick<Note, 'id' | 'projectId'>) =>
      request<{ success: true }>(`/${encodeURIComponent(note.id)}`, { method: 'DELETE' }),
    onSuccess: (_r, note) => {
      qc.removeQueries({ queryKey: noteKey(note.id) });
      void qc.invalidateQueries({ queryKey: notesKey(note.projectId) });
    },
  });
}

// ── Unseen agent edits (the dot in the sidebar) ───────────────────────
// Session-local: a note an agent changed since this tab last showed it.
let unseen = new Set<string>();
const unseenListeners = new Set<() => void>();
const emitUnseen = () => unseenListeners.forEach((l) => l());

export function markNoteSeen(id: string): void {
  if (!unseen.has(id)) return;
  unseen = new Set(unseen);
  unseen.delete(id);
  emitUnseen();
}

export function useUnseenNotes(): Set<string> {
  return useSyncExternalStore(
    (l) => { unseenListeners.add(l); return () => { unseenListeners.delete(l); }; },
    () => unseen,
  );
}

/** Ids of notes a note pane currently shows — an agent edit there is seen at once. */
const openNoteIds = new Map<string, number>();
export function useNoteOpen(id: string | null | undefined): void {
  useEffect(() => {
    if (!id) return;
    openNoteIds.set(id, (openNoteIds.get(id) ?? 0) + 1);
    markNoteSeen(id);
    return () => {
      const n = (openNoteIds.get(id) ?? 1) - 1;
      if (n <= 0) openNoteIds.delete(id); else openNoteIds.set(id, n);
    };
  }, [id]);
}

/**
 * Mounted once (AppContent): turns the host's `notes` events into query
 * invalidations, and remembers agent edits of notes no pane shows.
 */
export function useNotesLiveSync(): void {
  const qc = useQueryClient();
  useEffect(() => {
    const onNotes = (event: Event) => {
      const detail = (event as CustomEvent<NotesChange & { spaceId?: string | null }>).detail;
      // The stream carries every space's notes. Queries are per space (they
      // run under the active space's header), so only the active space's
      // changes refetch; the unseen dot is tracked for every space, so a
      // note edited while you were in another space is marked when you return.
      const activeSpace = (detail.spaceId ?? null) === getActiveSpaceId();
      const { changed } = detail;
      let unseenChanged = false;
      for (const c of changed) {
        if (activeSpace) {
          void qc.invalidateQueries({ queryKey: notesKey(c.projectId) });
          void qc.invalidateQueries({ queryKey: noteKey(c.id) });
        }
        if (c.lastEditor === 'agent' && !openNoteIds.has(c.id) && !unseen.has(c.id)) {
          unseen = new Set(unseen).add(c.id);
          unseenChanged = true;
        }
      }
      if (unseenChanged) emitUnseen();
    };
    window.addEventListener('cockpit:notes', onNotes);
    return () => window.removeEventListener('cockpit:notes', onNotes);
  }, [qc]);
}

/** Brain timestamps come as ISO or as SQLite UTC ("YYYY-MM-DD HH:MM:SS"). */
export function parseBrainDate(value: string): Date {
  const iso = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  return new Date(iso);
}

/** "now", "5m", "3h", "2d", or a date — the sidebar's compact age. */
export function noteAge(value: string, now: Date = new Date()): string {
  const date = parseBrainDate(value);
  if (Number.isNaN(date.getTime())) return '';
  const minutes = Math.floor(Math.max(0, now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return date.toLocaleDateString();
}
