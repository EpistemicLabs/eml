// File chips under an agent's reply (mockup v3): each file the reply names that the viewer can show.
// A click opens it in the slide-over, alone, since its chat is on screen; ← → flip through every
// file of the chat.
import { useMemo } from 'react';

import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';

import { extractFileRefs, formatSize, typeLabel } from './file-refs';
import { openMedia, useFileStats, type FileInfo, type SourceChat } from './files';

/** At most this many paths of a chat are looked up: the newest ones. */
const MAX_CHAT_REFS = 50;

export interface ChatFiles {
  /** Every file of the chat, in the order the chat names them. */
  list: FileInfo[];
  byRef: Map<string, FileInfo>;
}

const NO_FILES: ChatFiles = { list: [], byRef: new Map() };

/** The files a chat's replies name, looked up once for the whole chat. */
export function useChatFiles(texts: string[], sessionId: string | null): ChatFiles {
  const refs = useMemo(() => {
    const all: string[] = [];
    const seen = new Set<string>();
    for (const text of texts) for (const ref of extractFileRefs(text)) if (!seen.has(ref)) { seen.add(ref); all.push(ref); }
    return all.slice(-MAX_CHAT_REFS);
  }, [texts]);
  const { data } = useFileStats(refs, sessionId);
  return useMemo(() => {
    if (!data?.length) return NO_FILES;
    const byRef = new Map(data.map((file) => [file.ref, file]));
    const list: FileInfo[] = [];
    const paths = new Set<string>();
    for (const ref of refs) {
      const file = byRef.get(ref);
      if (file && !paths.has(file.path)) { paths.add(file.path); list.push(file); }
    }
    return { list, byRef };
  }, [data, refs]);
}

export function FileChip({ file, onOpen, className }: { file: FileInfo; onOpen: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={file.path}
      className={cn(
        'inline-flex max-w-(--size-file-chip) min-h-(--target-comfortable) items-center gap-2 rounded-lg border border-border bg-card py-1 pr-2.5 pl-1.5 text-left text-ui',
        'transition-colors duration-(--duration-fast) hover:border-border-strong',
        FOCUS,
        className,
      )}
    >
      <span className="grid min-w-8 place-items-center rounded-sm bg-muted px-1 py-0.5 font-code text-caption uppercase">{typeLabel(file.path)}</span>
      <span className="min-w-0 truncate font-medium text-foreground">{file.name}</span>
      <span className="whitespace-nowrap text-muted-foreground">{formatSize(file.size)}</span>
    </button>
  );
}

/** The chips of one reply: the files its text names, out of the chat's files. */
export function FileChips({ text, files, chat }: { text: string; files: ChatFiles; chat?: SourceChat | null }) {
  const own = useMemo(() => {
    const paths = new Set<string>();
    return extractFileRefs(text).flatMap((ref) => {
      const file = files.byRef.get(ref);
      if (!file || paths.has(file.path)) return [];
      paths.add(file.path);
      return [file];
    });
  }, [text, files]);
  if (own.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Files">
      {own.map((file) => (
        <FileChip
          key={file.path}
          file={file}
          onOpen={() => openMedia({ files: files.list, index: Math.max(0, files.list.findIndex((f) => f.path === file.path)), chat: chat ?? null })}
        />
      ))}
    </div>
  );
}
