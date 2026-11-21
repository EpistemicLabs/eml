// A diff as the repository view shows it: the changed files, each a card that
// opens to its patch — the changed hunks with a little context, the old and
// the new line numbers, coloured like the file (highlight.ts).
import { useMemo, useState } from 'react';
import { ChevronRight, FileText, Loader2 } from 'lucide-react';

import { cn } from '@/lib/utils';

import { usePatch, type FileChange, type Scope, type Where } from './api';
import { highlightLines, useLanguage, type Token } from './highlight';

export const ADDED = 'var(--color-success)';
export const REMOVED = 'var(--color-primary)';
export const CHANGED = 'var(--color-review)';

/** A file's patch opens by itself up to this many changed lines, for the first files of a list. */
const OPEN_LINES = 80;
const OPEN_FILES = 20;

export const STATUS: Record<string, { word: string; color: string }> = {
  A: { word: 'added', color: ADDED },
  '?': { word: 'new, not yet tracked', color: ADDED },
  M: { word: 'modified', color: CHANGED },
  D: { word: 'deleted', color: REMOVED },
  R: { word: 'renamed', color: CHANGED },
  C: { word: 'copied', color: CHANGED },
  T: { word: 'type changed', color: CHANGED },
};

export function DiffList({ where, scope, files, onOpenFile }: {
  where: Where;
  scope: Scope;
  files: FileChange[];
  /** Show the whole file (the Files tab); unset where the file may be gone. */
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      {files.map((file, index) => (
        <FileDiff
          key={`${file.oldPath ?? ''}>${file.path}`}
          where={where}
          scope={scope}
          file={file}
          openAtFirst={index < OPEN_FILES && (file.additions ?? OPEN_LINES) + (file.deletions ?? 0) <= OPEN_LINES}
          onOpenFile={file.status !== 'D' ? onOpenFile : undefined}
        />
      ))}
    </div>
  );
}

/** +12 −3 for a list of files. */
export function Totals({ files }: { files: FileChange[] }) {
  const added = files.reduce((sum, f) => sum + (f.additions ?? 0), 0);
  const removed = files.reduce((sum, f) => sum + (f.deletions ?? 0), 0);
  return (
    <span className="flex items-center gap-1.5 font-mono text-caption tabular-nums">
      <span style={{ color: ADDED }}>+{added}</span>
      <span style={{ color: REMOVED }}>−{removed}</span>
    </span>
  );
}

function FileDiff({ where, scope, file, openAtFirst, onOpenFile }: {
  where: Where;
  scope: Scope;
  file: FileChange;
  openAtFirst: boolean;
  onOpenFile?: (path: string) => void;
}) {
  const [open, setOpen] = useState(openAtFirst);
  const [reveal, setReveal] = useState(false);
  const patch = usePatch(where, scope, file, reveal, open);
  const status = STATUS[file.status] ?? STATUS.M;
  const slash = file.path.lastIndexOf('/');

  return (
    <div className="overflow-hidden rounded-lg border border-foreground/8 bg-foreground/[0.03]">
      <div className="group/file flex min-w-0 items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight className={cn('h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
          <span className="w-3 flex-shrink-0 text-center font-mono text-xs font-semibold" style={{ color: status.color }} title={status.word}>
            {file.status === '?' ? 'U' : file.status}
          </span>
          <span className="min-w-0 truncate font-mono text-xs" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
            {file.oldPath && <span className="text-muted-foreground">{file.oldPath} → </span>}
            <span className="text-muted-foreground">{file.path.slice(0, slash + 1)}</span>
            <span className="font-medium text-foreground">{file.path.slice(slash + 1)}</span>
          </span>
        </button>
        <span className="flex flex-shrink-0 items-center gap-1.5 font-mono text-caption tabular-nums">
          {file.additions === null ? (
            <span className="text-muted-foreground">binary</span>
          ) : (
            <>
              <span style={{ color: ADDED }}>+{file.additions}</span>
              <span style={{ color: REMOVED }}>−{file.deletions ?? 0}</span>
            </>
          )}
        </span>
        {onOpenFile && (
          <button
            type="button"
            onClick={() => onOpenFile(file.path)}
            title="Show the whole file"
            aria-label="Show the whole file"
            className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
          >
            <FileText className="h-3 w-3" />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-foreground/8">
          {patch.isPending ? (
            <Note><Loader2 className="h-3.5 w-3.5 animate-spin" /></Note>
          ) : patch.isError ? (
            <Note>{patch.error.message}</Note>
          ) : patch.data.secret ? (
            <Note>
              This file looks like it holds secrets.{' '}
              <button type="button" onClick={() => setReveal(true)} className="text-primary hover:underline">Show its changes</button>
            </Note>
          ) : patch.data.tooLarge ? (
            <Note>Too large to show.</Note>
          ) : (
            <PatchLines patch={patch.data.patch ?? ''} fileName={file.path} truncated={patch.data.truncated} />
          )}
        </div>
      )}
    </div>
  );
}

interface Line {
  kind: 'context' | 'added' | 'removed' | 'hunk';
  text: string;
  oldNo: number | null;
  newNo: number | null;
  tokens?: Token[];
}

/** The lines of a unified patch from its first hunk on; headers (diff --git, index, ---/+++) are left out. */
export function parsePatch(patch: string): Line[] {
  const lines: Line[] = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: hunk[3].trim(), oldNo: null, newNo: null });
    } else if (!inHunk || raw.startsWith('\\')) {
      continue;
    } else if (raw.startsWith('+')) {
      lines.push({ kind: 'added', text: raw.slice(1), oldNo: null, newNo: newNo++ });
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'removed', text: raw.slice(1), oldNo: oldNo++, newNo: null });
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'context', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    } else if (raw.startsWith('diff ')) {
      inHunk = false;
    }
  }
  return lines;
}

/**
 * Colours both sides of a patch: the new side (context and added lines) and
 * the old one (context and removed) are each parsed as one text, so a token
 * that spans lines — a comment, a string — colours right within a hunk.
 */
function colour(lines: Line[], highlight: (text: string) => Token[][]): Line[] {
  const side = (kinds: Line['kind'][]) => {
    const picked = lines.filter((line) => kinds.includes(line.kind));
    return new Map(highlight(picked.map((line) => line.text).join('\n')).map((tokens, i) => [picked[i], tokens]));
  };
  const added = side(['context', 'added']);
  const removed = side(['removed']);
  return lines.map((line) => ({ ...line, tokens: added.get(line) ?? removed.get(line) }));
}

export function PatchLines({ patch, fileName, truncated }: { patch: string; fileName: string; truncated: boolean }) {
  const language = useLanguage(fileName);
  const lines = useMemo(() => colour(parsePatch(patch), (text) => highlightLines(text, language)), [patch, language]);
  if (lines.length === 0) {
    return <Note>{/^Binary/m.test(patch) ? 'Binary file — no lines to show.' : 'No changes to the content (renamed or mode changed).'}</Note>;
  }
  return (
    <div className="repo-code overflow-x-auto font-mono text-[12px] leading-[18px]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) =>
            line.kind === 'hunk' ? (
              <tr key={i} className="bg-foreground/[0.04] text-muted-foreground">
                <td colSpan={3} className="px-2 py-0.5 text-[11px]">
                  <span className="opacity-60">⋯</span> {line.text}
                </td>
              </tr>
            ) : (
              <tr
                key={i}
                style={{
                  background:
                    line.kind === 'added' ? `color-mix(in srgb, ${ADDED} 12%, transparent)`
                      : line.kind === 'removed' ? `color-mix(in srgb, ${REMOVED} 12%, transparent)` : undefined,
                }}
              >
                <td className="w-px select-none whitespace-nowrap px-1.5 text-right align-top text-muted-foreground/70 tabular-nums">{line.oldNo ?? ''}</td>
                <td className="w-px select-none whitespace-nowrap px-1.5 text-right align-top text-muted-foreground/70 tabular-nums">{line.newNo ?? ''}</td>
                <td className="whitespace-pre pr-3 align-top">
                  <span
                    className="inline-block w-4 select-none text-center"
                    style={{ color: line.kind === 'added' ? ADDED : line.kind === 'removed' ? REMOVED : undefined }}
                  >
                    {line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}
                  </span>
                  {(line.tokens ?? [{ text: line.text, cls: '' }]).map((token, j) => (
                    <span key={j} className={token.cls || undefined}>{token.text}</span>
                  ))}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
      {truncated && <Note>The patch is cut off here — it is too long to show whole.</Note>}
    </div>
  );
}

export function Note({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1 px-3 py-2 text-caption text-muted-foreground">{children}</div>;
}
