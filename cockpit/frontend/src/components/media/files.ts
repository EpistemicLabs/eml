// The media viewer's data (host: files-api.ts) and what is open in the slide-over
// (decision cockpit-media-viewer-v3): a chip in a chat opens its file alone, since the chat is on
// screen; a file found with ⌘K opens wide, with the chat it comes from beside it.
import { useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import type { FileKind } from './file-refs';

export interface FileInfo {
  /** The text as the message names it. */
  ref: string;
  /** The absolute path the host serves. */
  path: string;
  name: string;
  kind: FileKind;
  size: number;
  modifiedAt: string;
}

export interface RecentFile extends FileInfo {
  sessionId: string;
  sessionTitle: string;
  projectId: string | null;
  spaceId: string | null;
  seenAt: string;
}

/** Where the viewer reads a file's bytes. */
export const fileUrl = (path: string): string => `/api/file?path=${encodeURIComponent(path)}`;

async function statRefs(refs: string[], sessionId: string | null): Promise<FileInfo[]> {
  const res = await fetch('/api/files/stat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refs, ...(sessionId ? { sessionId } : {}) }),
  });
  if (!res.ok) return [];
  const body = (await res.json().catch(() => null)) as { files?: FileInfo[] } | null;
  return body?.files ?? [];
}

/** Which of the paths a message names are files to show; a relative one is read from the session's folder. */
export function useFileStats(refs: string[], sessionId: string | null) {
  return useQuery({
    queryKey: ['file-stats', sessionId, refs],
    queryFn: () => statRefs(refs, sessionId),
    enabled: refs.length > 0,
    staleTime: 30_000,
  });
}

/** The files recent chats name, for ⌘K. */
export function useRecentFiles(enabled: boolean) {
  return useQuery({
    queryKey: ['recent-files'],
    queryFn: async (): Promise<RecentFile[]> => {
      const res = await fetch('/api/files/recent');
      if (!res.ok) return [];
      const body = (await res.json().catch(() => null)) as { files?: RecentFile[] } | null;
      return body?.files ?? [];
    },
    enabled,
    staleTime: 30_000,
  });
}

// ── The slide-over ──────────────────────────────────────────────────

export interface SourceChat {
  sessionId: string;
  projectId: string | null;
  spaceId: string | null;
  title: string;
}

export interface MediaOpen {
  /** The files to flip through (← →): the message's or the chat's files. */
  files: FileInfo[];
  index: number;
  /** Set when the file opens with its chat beside it (⌘K). */
  chat: SourceChat | null;
}

let open: MediaOpen | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function openMedia(next: MediaOpen): void {
  open = { ...next, index: Math.max(0, Math.min(next.index, next.files.length - 1)) };
  emit();
}

export function stepMedia(delta: number): void {
  if (!open) return;
  const index = open.index + delta;
  if (index < 0 || index >= open.files.length) return;
  open = { ...open, index };
  emit();
}

export function showMediaAt(index: number): void {
  if (!open || index < 0 || index >= open.files.length) return;
  open = { ...open, index };
  emit();
}

export function closeMedia(): void {
  if (!open) return;
  open = null;
  emit();
}

export function getMediaOpen(): MediaOpen | null {
  return open;
}

export function useMediaOpen(): MediaOpen | null {
  return useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => open,
  );
}
