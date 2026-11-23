// Trimmed: mobile menu button, i18n (literals). The empty pane is the session launcher
// (components/session-launcher); "Choose Your Project" is gone.
import { SessionLauncher } from '@/components/session-launcher/SessionLauncher';

import type { MainContentStateViewProps } from '../../types/types';

export default function MainContentStateView({ mode, paneId }: MainContentStateViewProps) {
  const isLoading = mode === 'loading';
  if (!isLoading && paneId) return <SessionLauncher paneId={paneId} />;

  return (
    <div className="flex h-full flex-col">
      {isLoading ? (
        <div className="flex flex-1 items-center justify-center">
          <div className="text-center text-muted-foreground">
            <div className="mx-auto mb-4 h-10 w-10">
              <div className="h-full w-full animate-spin rounded-full border-3 border-muted border-t-foreground" />
            </div>
            <h2 className="mb-1 text-display font-semibold text-foreground">Loading…</h2>
            <p className="text-body">Loading your projects</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}
