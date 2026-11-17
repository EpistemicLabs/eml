// The Changes plugin's data: /api/plugins/repository/* (host plugins-repository.ts).
// Every request names the project and the checkout (a worktree's folder;
// none: the project folder's).
import { useQuery } from '@tanstack/react-query';

export interface Checkout {
  path: string;
  /** null: a detached HEAD. */
  branch: string | null;
  head: string;
  isProjectFolder: boolean;
}

export interface Checkouts {
  folder: string;
  base: string | null;
  /** null: the folder is no git repository. */
  worktrees: Checkout[] | null;
}

export interface FileChange {
  path: string;
  oldPath: string | null;
  /** A M D R C T, or ? for a new file git doesn't track yet. */
  status: string;
  additions: number | null;
  deletions: number | null;
}

export interface Commit {
  hash: string;
  subject: string;
  author: string;
  at: string;
}

export type Scope = { kind: 'uncommitted' } | { kind: 'branch' } | { kind: 'commit'; sha: string };

export interface Patch {
  patch: string | null;
  truncated: boolean;
  secret: boolean;
  tooLarge?: boolean;
}

export interface FileContent {
  size: number;
  secret: boolean;
  binary: boolean;
  tooLarge: boolean;
  content: string | null;
}

/** A while the pane is open: an agent may be changing the checkout right now. */
const REFRESH_MS = 30_000;

export interface Where {
  projectId: string;
  /** The worktree's folder; undefined: the project folder. */
  worktree?: string;
}

async function get<T>(route: string, where: Where, query: Record<string, string | undefined> = {}): Promise<T> {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries({ projectId: where.projectId, worktree: where.worktree, ...query })) {
    if (value) params.set(key, value);
  }
  const res = await fetch(`/api/plugins/repository/${route}?${params}`, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data as T;
}

const scopeQuery = (scope: Scope) => ({ scope: scope.kind, commit: scope.kind === 'commit' ? scope.sha : undefined });
const scopeKey = (scope: Scope) => (scope.kind === 'commit' ? `commit:${scope.sha}` : scope.kind);

export const useCheckouts = (projectId: string) =>
  useQuery({
    queryKey: ['repository-repo', projectId],
    queryFn: () => get<Checkouts>('repo', { projectId }),
    refetchInterval: REFRESH_MS,
  });

export const useChangedFiles = (where: Where, scope: Scope, enabled = true) =>
  useQuery({
    queryKey: ['repository-files', where.projectId, where.worktree, scopeKey(scope)],
    queryFn: () => get<{ files: FileChange[]; truncated: boolean }>('files', where, scopeQuery(scope)),
    enabled,
    // A commit doesn't change; the working tree and the branch do.
    refetchInterval: scope.kind === 'commit' ? false : REFRESH_MS,
    retry: false,
  });

/** A file's patch; refetched when its counts change, so an open diff follows the agent's edits. */
export const usePatch = (where: Where, scope: Scope, file: FileChange, reveal: boolean, enabled: boolean) =>
  useQuery({
    queryKey: ['repository-patch', where.projectId, where.worktree, scopeKey(scope), file.path, file.additions, file.deletions, reveal],
    queryFn: () =>
      get<Patch>('patch', where, {
        ...scopeQuery(scope),
        path: file.path,
        oldPath: file.oldPath ?? undefined,
        status: file.status,
        reveal: reveal ? '1' : undefined,
      }),
    enabled,
  });

export const useCommits = (where: Where) =>
  useQuery({
    queryKey: ['repository-commits', where.projectId, where.worktree],
    queryFn: () => get<{ base: string | null; onBranch: boolean; commits: Commit[] }>('commits', where),
    refetchInterval: REFRESH_MS,
  });

export const useTree = (where: Where, enabled: boolean) =>
  useQuery({
    queryKey: ['repository-tree', where.projectId, where.worktree],
    queryFn: () => get<{ paths: string[]; ignored: string[]; truncated: boolean }>('tree', where),
    enabled,
    refetchInterval: REFRESH_MS,
  });

export const useDir = (where: Where, path: string) =>
  useQuery({
    queryKey: ['repository-dir', where.projectId, where.worktree, path],
    queryFn: () => get<{ entries: Array<{ name: string; dir: boolean }>; truncated: boolean }>('dir', where, { path }),
  });

export const useFileContent = (where: Where, path: string, reveal: boolean) =>
  useQuery({
    queryKey: ['repository-file', where.projectId, where.worktree, path, reveal],
    queryFn: () => get<FileContent>('file', where, { path, reveal: reveal ? '1' : undefined }),
  });
