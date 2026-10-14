// Trimmed: mobile menu button, i18n (literals).
import { Folder } from 'lucide-react';

import type { MainContentStateViewProps } from '../../types/types';

export default function MainContentStateView({ mode }: MainContentStateViewProps) {
  const isLoading = mode === 'loading';

  return (
    <div className="flex h-full flex-col">
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div
                className="h-full w-full rounded-full border-[3px] border-muted border-t-primary"
                style={{ animation: 'spin 1s linear infinite' }}
              />
            </div>
            <h2 className="mb-1 text-display font-semibold text-foreground">Loading…</h2>
            <p className="text-body">Loading your projects</p>
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <div className="mx-auto max-w-md px-6 text-center">
            <div className="mx-auto mb-5 flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/50">
              <Folder className="h-7 w-7 text-muted-foreground" />
            </div>
            <h2 className="mb-2 text-jumbo font-semibold text-foreground">Choose Your Project</h2>
            <p className="mb-5 text-body leading-relaxed text-muted-foreground">
              Select a project from the sidebar to start a session with Claude. Each project contains
              your sessions.
            </p>
            <div className="rounded-xl border border-primary/10 bg-primary/5 p-3.5">
              <p className="text-body text-primary">
                <strong>Tip:</strong> Add a project by clicking the + icon in the sidebar
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
