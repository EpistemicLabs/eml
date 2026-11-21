// The Files tab: the checkout's whole tree and one file in it. A git
// checkout's tree comes in one list (tracked and new files); the folders git
// ignores show greyed behind a switch and list their entries as they open, as
// a folder that is no repository does throughout. A pane wider than the tree
// needs shows tree and file side by side; a narrow one shows one at a time.
import { useMemo, useState } from 'react';
import { ArrowLeft, ChevronRight, File, Folder, Loader2, Search } from 'lucide-react';

import { cn } from '@/lib/utils';

import { useDir, useFileContent, useTree, type Where } from './api';
import { CodeView } from './CodeView';
import { Note, STATUS } from './DiffList';

interface Node {
  name: string;
  path: string;
  dir: boolean;
  /** Ignored by git (shown greyed). */
  ignored?: boolean;
  /** Children known from the tree list; undefined on a folder listed as it opens. */
  children?: Map<string, Node>;
}

const SEARCH_RESULTS = 50;

function buildTree(paths: string[], ignored: string[]): Node {
  const root: Node = { name: '', path: '', dir: true, children: new Map() };
  const add = (full: string, flags: { ignored?: boolean; lazy?: boolean }) => {
    const parts = full.replace(/\/$/, '').split('/');
    let node = root;
    parts.forEach((name, i) => {
      const last = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children?.get(name);
      if (!child) {
        const dir = !last || full.endsWith('/');
        child = { name, path, dir, ignored: last ? flags.ignored : undefined, children: dir && !(last && flags.lazy) ? new Map() : undefined };
        node.children?.set(name, child);
      }
      node = child;
    });
  };
  paths.forEach((p) => add(p, {}));
  ignored.forEach((p) => add(p, { ignored: true, lazy: true }));
  return root;
}

const sorted = (nodes: Iterable<Node>) =>
  [...nodes].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));

/** How well `query` matches `path` as a subsequence; null: it doesn't. Matches in the file name, after a separator and in a row count more. */
export function fuzzyScore(query: string, path: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  const p = path.toLowerCase();
  const nameStart = p.lastIndexOf('/') + 1;
  let score = 0;
  let at = 0;
  let previous = -2;
  for (const ch of q) {
    const found = p.indexOf(ch, at);
    if (found === -1) return null;
    score += 1;
    if (found === previous + 1) score += 3;
    if (found === 0 || '/._-'.includes(p[found - 1])) score += 2;
    if (found >= nameStart) score += 2;
    previous = found;
    at = found + 1;
  }
  return score - path.length * 0.01;
}

export function FilesTab({ where, git, changed, file, onSelect }: {
  where: Where;
  git: boolean;
  /** The checkout's uncommitted changes: path → status. */
  changed: Map<string, string>;
  file: string | undefined;
  onSelect: (path: string | undefined) => void;
}) {
  return (
    <div className="@container h-full min-h-0">
      <div className="grid h-full min-h-0 @2xl:grid-cols-[minmax(200px,280px)_1fr]">
        <div className={cn('min-h-0 border-foreground/8 @2xl:block @2xl:border-r', file ? 'hidden' : 'block')}>
          <Tree where={where} git={git} changed={changed} file={file} onSelect={onSelect} />
        </div>
        <div className={cn('min-h-0 @2xl:block', file ? 'block' : 'hidden')}>
          {file ? (
            <FileView key={`${where.worktree ?? ''}:${file}`} where={where} path={file} status={changed.get(file)} onBack={() => onSelect(undefined)} />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Pick a file to read it.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function Tree({ where, git, changed, file, onSelect }: {
  where: Where;
  git: boolean;
  changed: Map<string, string>;
  file: string | undefined;
  onSelect: (path: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [showIgnored, setShowIgnored] = useState(false);
  // The folders down to the open file start open.
  const [open, setOpen] = useState<Set<string>>(() => new Set(file ? file.split('/').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join('/')) : []));
  const tree = useTree(where, git);
  const root = useMemo(
    () => (tree.data ? buildTree(tree.data.paths, showIgnored ? tree.data.ignored : []) : null),
    [tree.data, showIgnored],
  );
  // A folder holding a change is marked while closed.
  const changedDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const path of changed.keys()) {
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    }
    return dirs;
  }, [changed]);
  const results = useMemo(() => {
    if (!query.trim() || !tree.data) return null;
    return tree.data.paths
      .map((path) => ({ path, score: fuzzyScore(query, path) }))
      .filter((r): r is { path: string; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, SEARCH_RESULTS);
  }, [query, tree.data]);

  const toggle = (path: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  const row = { open, toggle, changed, changedDirs, file, onSelect, where };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {git && (
        <div className="flex flex-shrink-0 items-center gap-1.5 px-2 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border border-foreground/10 bg-foreground/[0.03] px-2 py-1">
            <Search className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results?.[0]) onSelect(results[0].path);
                if (e.key === 'Escape') setQuery('');
              }}
              placeholder="Go to file…"
              aria-label="Go to file"
              className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowIgnored((s) => !s)}
            aria-pressed={showIgnored}
            title={showIgnored ? 'Hide what git ignores' : 'Show what git ignores (node_modules, builds …)'}
            className={cn(
              'flex-shrink-0 rounded-md px-1.5 py-1 text-[10px] font-medium transition-colors',
              showIgnored ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            ignored
          </button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {!git ? (
          <LazyChildren {...row} path="" depth={0} ignored={false} />
        ) : tree.isPending ? (
          <Note><Loader2 className="h-3.5 w-3.5 animate-spin" /></Note>
        ) : tree.isError ? (
          <Note>{tree.error.message}</Note>
        ) : results ? (
          results.length === 0 ? <Note>No file matches.</Note> : results.map(({ path }) => (
            <button
              key={path}
              type="button"
              onClick={() => onSelect(path)}
              className={cn('flex w-full min-w-0 flex-col px-3 py-1 text-left transition-colors hover:bg-foreground/5', path === file && 'bg-foreground/[0.07]')}
            >
              <span className="truncate text-xs text-foreground" style={{ color: statusColor(changed.get(path)) }}>{path.split('/').pop()}</span>
              <span className="truncate font-mono text-[10px] text-muted-foreground">{path}</span>
            </button>
          ))
        ) : (
          <>
            {root && sorted(root.children!.values()).map((node) => <TreeNode key={node.path} {...row} node={node} depth={0} />)}
            {tree.data.truncated && <Note>The tree is cut off — the checkout has too many files.</Note>}
          </>
        )}
      </div>
    </div>
  );
}

const statusColor = (status: string | undefined) => (status ? (STATUS[status] ?? STATUS.M).color : undefined);

interface RowProps {
  where: Where;
  open: Set<string>;
  toggle: (path: string) => void;
  changed: Map<string, string>;
  changedDirs: Set<string>;
  file: string | undefined;
  onSelect: (path: string) => void;
}

function TreeNode({ node, depth, ...row }: RowProps & { node: Node; depth: number }) {
  const isOpen = row.open.has(node.path);
  const status = row.changed.get(node.path);
  return (
    <>
      <button
        type="button"
        onClick={() => (node.dir ? row.toggle(node.path) : row.onSelect(node.path))}
        aria-expanded={node.dir ? isOpen : undefined}
        style={{ paddingLeft: 8 + depth * 12 }}
        className={cn(
          'flex w-full min-w-0 items-center gap-1 py-[3px] pr-2 text-left text-xs transition-colors hover:bg-foreground/5',
          node.path === row.file && 'bg-foreground/[0.07]',
          node.ignored && 'opacity-50',
        )}
      >
        {node.dir ? (
          <>
            <ChevronRight className={cn('h-3 w-3 flex-shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
            <Folder className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
          </>
        ) : (
          <>
            <span className="w-3 flex-shrink-0" />
            <File className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/70" />
          </>
        )}
        <span className="min-w-0 truncate" style={{ color: statusColor(status) }}>{node.name}</span>
        {node.dir && !isOpen && row.changedDirs.has(node.path) && (
          <span className="ml-auto h-1.5 w-1.5 flex-shrink-0 rounded-full" style={{ background: 'var(--color-review)' }} title="Holds changes" />
        )}
        {status && <span className="ml-auto flex-shrink-0 font-mono text-[10px]" style={{ color: statusColor(status) }}>{status === '?' ? 'U' : status}</span>}
      </button>
      {node.dir && isOpen && (
        node.children
          ? sorted(node.children.values()).map((child) => <TreeNode key={child.path} {...row} node={child} depth={depth + 1} />)
          : <LazyChildren {...row} path={node.path} depth={depth + 1} ignored={Boolean(node.ignored)} />
      )}
    </>
  );
}

/** A folder's entries, asked for as it opens. */
function LazyChildren({ path, depth, ignored, ...row }: RowProps & { path: string; depth: number; ignored: boolean }) {
  const dir = useDir(row.where, path);
  if (dir.isPending) return <div style={{ paddingLeft: 8 + depth * 12 }} className="py-1"><Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /></div>;
  if (dir.isError) return <div style={{ paddingLeft: 8 + depth * 12 }} className="py-1 text-caption text-muted-foreground">{dir.error.message}</div>;
  return (
    <>
      {dir.data.entries.map((entry) => {
        const full = path ? `${path}/${entry.name}` : entry.name;
        return <TreeNode key={full} {...row} node={{ name: entry.name, path: full, dir: entry.dir, ignored }} depth={depth} />;
      })}
      {dir.data.truncated && <div style={{ paddingLeft: 8 + depth * 12 }} className="py-1 text-caption text-muted-foreground">… more entries not shown</div>}
    </>
  );
}

const kilobytes = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

function FileView({ where, path, status, onBack }: { where: Where; path: string; status: string | undefined; onBack: () => void }) {
  const [reveal, setReveal] = useState(false);
  const file = useFileContent(where, path, reveal);
  const slash = path.lastIndexOf('/');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-foreground/8 px-2 pb-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to the files"
          title="Back to the files"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground @2xl:hidden"
        >
          <ArrowLeft className="h-3 w-3" />
        </button>
        <span className="min-w-0 truncate font-mono text-xs" title={path}>
          <span className="text-muted-foreground">{path.slice(0, slash + 1)}</span>
          <span className="font-medium text-foreground">{path.slice(slash + 1)}</span>
        </span>
        {status && <span className="flex-shrink-0 text-[10px]" style={{ color: statusColor(status) }}>{(STATUS[status] ?? STATUS.M).word}</span>}
        {file.data && <span className="ml-auto flex-shrink-0 text-caption tabular-nums text-muted-foreground">{kilobytes(file.data.size)}</span>}
      </div>
      <div className="min-h-0 flex-1">
        {file.isPending ? (
          <Note><Loader2 className="h-3.5 w-3.5 animate-spin" /></Note>
        ) : file.isError ? (
          <Note>{file.error.message}</Note>
        ) : file.data.tooLarge ? (
          <Note>Too large to show here.</Note>
        ) : file.data.binary ? (
          <Note>A binary file — nothing to read here.</Note>
        ) : file.data.content === null && file.data.secret ? (
          <Note>
            This file looks like it holds secrets.{' '}
            <button type="button" onClick={() => setReveal(true)} className="text-primary hover:underline">Show its content</button>
          </Note>
        ) : file.data.content === null ? (
          <Note>Not a file.</Note>
        ) : (
          <CodeView content={file.data.content} fileName={path} />
        )}
      </div>
    </div>
  );
}
