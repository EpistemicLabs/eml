// The `repository` pane view (task cockpit-plugin-changes): a read-only code view
// of one checkout of the project — the project folder or one of its git
// worktrees. Changes shows what is uncommitted and what the branch added
// since the default branch, Files the whole tree and any file in it, Commits
// the branch's commits and each one's diff. The pane keeps where it was left
// (repositoryView). Data: /api/plugins/repository/* (host plugins-repository.ts).
// Loaded on first use (MainContent): it brings CodeMirror.
import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, GitBranch, Loader2, RefreshCw } from 'lucide-react';

import { BrainCard, SectionHeader } from '@/components/brain/ui';
import { compactAge } from '@/components/sidebar/utils';
import { cn } from '@/lib/utils';
import { FOCUS, TAB, TRACK } from '@/shared/view/ui';
import { updatePane, usePane, type RepositoryPaneView } from '@/stores/usePaneStore';
import type { Project } from '@/types/app';

import { useChangedFiles, useCheckouts, useCommits, type Checkout, type Where } from './api';
import { DiffList, Note, Totals } from './DiffList';
import { FilesTab } from './FilesTab';
import './repository.css';

const FIRST_VIEW: RepositoryPaneView = { tab: 'changes' };
const TABS: Array<{ id: RepositoryPaneView['tab']; label: string }> = [
  { id: 'changes', label: 'Changes' },
  { id: 'files', label: 'Files' },
  { id: 'commits', label: 'Commits' },
];

const checkoutLabel = (wt: Checkout) => `${wt.branch ?? `detached at ${wt.head.slice(0, 7)}`}${wt.isProjectFolder ? ' · project folder' : ''}`;

export function RepositoryPane({ paneId, project }: { paneId: string; project: Project | null }) {
  const view = usePane(paneId)?.repositoryView ?? FIRST_VIEW;
  const setView = (patch: Partial<RepositoryPaneView>) => updatePane(paneId, { repositoryView: { ...view, ...patch } });
  const qc = useQueryClient();
  const checkouts = useCheckouts(project?.projectId ?? '');

  if (!project) return <PaneMessage>Pick a project for this pane to see its repository.</PaneMessage>;
  if (!project.path) return <PaneMessage>This project has no folder yet — there is no code to show.</PaneMessage>;
  if (checkouts.isPending) return <PaneMessage><Loader2 className="h-4 w-4 animate-spin" /></PaneMessage>;
  if (checkouts.isError) return <PaneMessage>{checkouts.error.message}</PaneMessage>;

  const { worktrees, base } = checkouts.data;
  const git = worktrees !== null;
  // A worktree removed since the pane was left: back to the project folder.
  const checkout = worktrees?.find((wt) => wt.path === view.worktree) ?? worktrees?.find((wt) => wt.isProjectFolder) ?? null;
  const where: Where = { projectId: project.projectId, worktree: checkout && !checkout.isProjectFolder ? checkout.path : undefined };
  const tab = git ? view.tab : 'files';
  const refreshing = qc.isFetching({ predicate: (q) => String(q.queryKey[0]).startsWith('repository-') }) > 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 flex-wrap items-center gap-2 px-3 pb-2">
        {git ? (
          <label className="flex min-h-(--target-min) min-w-0 max-w-full items-center gap-1.5 rounded-md border border-input bg-card pl-2 focus-within:outline-2 focus-within:outline-offset-(--focus-offset) focus-within:outline-ring" title={checkout?.path}>
            <GitBranch className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <select
              value={checkout?.path ?? ''}
              onChange={(e) => setView({ worktree: e.target.value, file: undefined, commit: undefined })}
              aria-label="Checkout"
              className="min-w-0 max-w-64 cursor-pointer truncate bg-transparent py-1 pr-1 text-ui font-medium text-foreground outline-none"
            >
              {worktrees.map((wt) => <option key={wt.path} value={wt.path}>{checkoutLabel(wt)}</option>)}
            </select>
          </label>
        ) : (
          <span className="min-w-0 truncate text-caption text-muted-foreground" title={checkouts.data.folder}>
            {checkouts.data.folder} · no git repository
          </span>
        )}
        {git && (
          <div className={cn(TRACK, 'bg-muted')} role="tablist">
            {TABS.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setView({ tab: id })}
                className={cn(TAB, 'transition-colors duration-(--duration-fast)')}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          onClick={() => void qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('repository-') })}
          aria-label="Refresh"
          title="Refresh"
          className={cn('ml-auto flex size-(--target-min) flex-shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-muted hover:text-foreground', FOCUS)}
        >
          <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
        </button>
      </div>
      <div className="min-h-0 flex-1">
        {tab === 'changes' && checkout ? (
          <ChangesTab key={checkout.path} where={where} checkout={checkout} base={base} onOpenFile={(file) => setView({ tab: 'files', file })} />
        ) : tab === 'commits' ? (
          <CommitsTab key={checkout?.path} where={where} commit={view.commit} onCommit={(commit) => setView({ commit })} onOpenFile={(file) => setView({ tab: 'files', file })} />
        ) : (
          <FilesWithChanges key={checkout?.path ?? ''} where={where} git={git} file={view.file} onSelect={(file) => setView({ file })} />
        )}
      </div>
    </div>
  );
}

function ChangesTab({ where, checkout, base, onOpenFile }: {
  where: Where;
  checkout: Checkout;
  base: string | null;
  onOpenFile: (path: string) => void;
}) {
  const uncommitted = useChangedFiles(where, { kind: 'uncommitted' });
  const branch = useChangedFiles(where, { kind: 'branch' }, Boolean(base));
  const name = checkout.branch ?? 'this checkout';
  const nothing = uncommitted.data?.files.length === 0 && (!base || branch.data?.files.length === 0 || branch.isError);

  return (
    <div className="h-full space-y-3 overflow-y-auto px-3 pb-3">
      <Section
        title="Uncommitted"
        query={uncommitted}
        empty="Nothing uncommitted."
        render={(files) => <DiffList where={where} scope={{ kind: 'uncommitted' }} files={files} onOpenFile={onOpenFile} />}
      />
      {base && !(branch.data?.files.length === 0) && (
        <Section
          title={`Committed on ${name} · since ${base}`}
          query={branch}
          empty=""
          render={(files) => <DiffList where={where} scope={{ kind: 'branch' }} files={files} onOpenFile={onOpenFile} />}
        />
      )}
      {nothing && (
        <p className="px-1 text-caption text-muted-foreground">
          {base ? `${name} is where ${base} is, and nothing is changed.` : 'Nothing is changed.'}
        </p>
      )}
    </div>
  );
}

function Section({ title, query, empty, render }: {
  title: string;
  query: ReturnType<typeof useChangedFiles>;
  empty: string;
  render: (files: NonNullable<ReturnType<typeof useChangedFiles>['data']>['files']) => React.ReactNode;
}) {
  const files = query.data?.files ?? [];
  return (
    <BrainCard className="p-3">
      <SectionHeader
        title={title}
        right={files.length > 0 && (
          <span className="flex items-center gap-2 text-caption tabular-nums text-muted-foreground">
            {files.length} {files.length === 1 ? 'file' : 'files'}
            <Totals files={files} />
          </span>
        )}
        className="mb-2"
      />
      {query.isPending ? (
        <Note><Loader2 className="h-3.5 w-3.5 animate-spin" /></Note>
      ) : query.isError ? (
        <Note>{query.error.message}</Note>
      ) : files.length === 0 ? (
        <Note>{empty}</Note>
      ) : (
        <>
          {render(files)}
          {query.data.truncated && <Note>Only the first {files.length} files are listed.</Note>}
        </>
      )}
    </BrainCard>
  );
}

function CommitsTab({ where, commit, onCommit, onOpenFile }: {
  where: Where;
  commit: string | undefined;
  onCommit: (hash: string | undefined) => void;
  onOpenFile: (path: string) => void;
}) {
  const commits = useCommits(where);
  const now = new Date();
  const picked = commits.data?.commits.find((c) => c.hash === commit);

  if (commit) {
    return (
      <div className="h-full space-y-2 overflow-y-auto px-3 pb-3">
        <button
          type="button"
          onClick={() => onCommit(undefined)}
          className={cn('flex min-h-(--target-min) items-center gap-1 rounded-md text-caption text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground', FOCUS)}
        >
          <ArrowLeft className="size-3" /> All commits
        </button>
        <BrainCard className="p-3">
          <div className="mb-2 min-w-0">
            <div className="text-body font-medium text-foreground">{picked?.subject ?? commit}</div>
            {picked && (
              <div className="text-caption text-muted-foreground">
                <span className="font-code">{picked.hash}</span> · {picked.author} · {compactAge(picked.at, now)} ago
              </div>
            )}
          </div>
          <CommitFiles where={where} sha={commit} onOpenFile={onOpenFile} />
        </BrainCard>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-3 pb-3">
      <BrainCard className="p-3">
        <SectionHeader
          title={commits.data && !commits.data.onBranch ? 'Latest commits' : `Since ${commits.data?.base ?? 'the default branch'}`}
          right={commits.data && <span className="text-caption tabular-nums text-muted-foreground">{commits.data.commits.length}</span>}
          className="mb-1.5"
        />
        {commits.isPending ? (
          <Note><Loader2 className="h-3.5 w-3.5 animate-spin" /></Note>
        ) : commits.isError ? (
          <Note>{commits.error.message}</Note>
        ) : commits.data.commits.length === 0 ? (
          <Note>No commits yet.</Note>
        ) : (
          <div className="space-y-0.5">
            {commits.data.commits.map((c) => (
              <button
                key={c.hash}
                type="button"
                onClick={() => onCommit(c.hash)}
                className={cn('-mx-1.5 flex min-h-(--target-min) w-(--size-worktree-row) min-w-0 items-baseline gap-2 rounded-md px-1.5 py-1 text-left text-ui transition-colors duration-(--duration-fast) hover:bg-muted', FOCUS)}
              >
                <span className="flex-shrink-0 font-code text-muted-foreground">{c.hash}</span>
                <span className="min-w-0 flex-1 truncate text-foreground" title={c.subject}>{c.subject}</span>
                <span className="hidden flex-shrink-0 text-caption text-muted-foreground sm:inline">{c.author}</span>
                <span className="w-8 flex-shrink-0 text-right text-caption tabular-nums text-muted-foreground">{compactAge(c.at, now)}</span>
              </button>
            ))}
          </div>
        )}
      </BrainCard>
    </div>
  );
}

function CommitFiles({ where, sha, onOpenFile }: { where: Where; sha: string; onOpenFile: (path: string) => void }) {
  const scope = useMemo(() => ({ kind: 'commit' as const, sha }), [sha]);
  const files = useChangedFiles(where, scope);
  if (files.isPending) return <Note><Loader2 className="h-3.5 w-3.5 animate-spin" /></Note>;
  if (files.isError) return <Note>{files.error.message}</Note>;
  if (files.data.files.length === 0) return <Note>This commit changes no file.</Note>;
  return <DiffList where={where} scope={scope} files={files.data.files} onOpenFile={onOpenFile} />;
}

/** Files, its tree marking what is uncommitted. */
function FilesWithChanges({ where, git, file, onSelect }: { where: Where; git: boolean; file: string | undefined; onSelect: (path: string | undefined) => void }) {
  const uncommitted = useChangedFiles(where, { kind: 'uncommitted' }, git);
  const changed = useMemo(
    () => new Map((uncommitted.data?.files ?? []).map((f) => [f.path, f.status])),
    [uncommitted.data],
  );
  return <FilesTab where={where} git={git} changed={changed} file={file} onSelect={onSelect} />;
}

function PaneMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center text-body text-muted-foreground">
      {children}
    </div>
  );
}
