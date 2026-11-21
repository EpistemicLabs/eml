import { PanelLeftOpen, Pin, PinOff, Settings, X } from 'lucide-react';

import SpaceSwitch from '@/components/app/SpaceSwitch';
import { cn } from '@/lib/utils';
import { Button, FOCUS, ROW, TAB, TRACK } from '@/shared/view/ui';
import type { SidebarError, SidebarViewMode } from '../../types';

export function SidebarRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex h-full w-(--size-sidebar-rail) flex-col items-center py-2">
      <button
        type="button"
        aria-label="Show sidebar"
        title="Show sidebar"
        onClick={onOpen}
        className={cn('group flex size-(--target-comfortable) items-center justify-center rounded-md transition-colors duration-(--duration-fast) hover:bg-muted', FOCUS)}
      >
        <PanelLeftOpen aria-hidden className="size-4 text-muted-foreground transition-colors duration-(--duration-fast) group-hover:text-foreground" />
      </button>
    </div>
  );
}

const MODES: Array<{ mode: SidebarViewMode; label: string }> = [
  { mode: 'overview', label: 'Overview' },
  { mode: 'projects', label: 'Projects' },
  { mode: 'conversations', label: 'Sessions' },
];

/** The sidebar's three views, right above their list; the overview is still in beta. */
export function SidebarModes({
  viewMode,
  onViewModeChange,
  waiting,
}: {
  viewMode: SidebarViewMode;
  onViewModeChange: (mode: SidebarViewMode) => void;
  /** What waits for the user: shown on the overview's tab while another view is open. */
  waiting: number;
}) {
  return (
    <div role="tablist" aria-label="Sidebar view" className={cn(TRACK, 'mx-2 mb-2 flex-shrink-0 bg-foreground/8')}>
      {MODES.map(({ mode, label }) => {
        const active = viewMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onViewModeChange(mode)}
            className={cn(TAB, 'min-w-0 flex-auto justify-center gap-1 px-1.5 text-ui')}
          >
            <span className="truncate">{label}</span>
            {mode === 'overview' && (
              <span className="text-caption leading-none font-normal text-muted-foreground" title="Beta">
                β
              </span>
            )}
            {mode === 'overview' && !active && waiting > 0 && (
              <span className="inline-grid h-4 min-w-4 place-items-center rounded-full bg-foreground px-1 text-caption leading-none font-bold text-background tabular-nums" aria-label={`${waiting} waiting`}>
                {waiting}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/** The top row: the space switch, then pin. */
export function SidebarHeader({
  isPinnedOpen,
  onTogglePinned,
}: {
  isPinnedOpen: boolean;
  /** Absent where pinning means nothing (the compact layout's drawer). */
  onTogglePinned?: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between gap-1 pt-2 pr-2 pb-1 pl-1">
      <div className="min-w-0 flex-1">
        <SpaceSwitch variant="sidebar" />
      </div>
      <div className="flex items-center gap-0.5">
        {onTogglePinned && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={isPinnedOpen ? 'Unpin sidebar' : 'Pin sidebar open'}
            className={cn('rounded-md', isPinnedOpen && 'text-foreground')}
            title={isPinnedOpen ? 'Unpin sidebar' : 'Pin sidebar open'}
            onClick={onTogglePinned}
          >
            {isPinnedOpen ? <PinOff /> : <Pin />}
          </Button>
        )}
      </div>
    </div>
  );
}

export function SidebarErrorLine({ error, onDismiss }: { error: SidebarError | null; onDismiss: () => void }) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="mx-2 mb-1 flex flex-shrink-0 items-start gap-2 rounded-md bg-status-stopped/10 py-0.5 pr-0.5 pl-2 text-ui text-stopped-ink"
    >
      <span className="min-w-0 flex-1 self-center break-words">{error.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
        className={cn('flex size-(--target-min) flex-shrink-0 items-center justify-center rounded-md text-stopped-ink transition-colors duration-(--duration-fast) hover:bg-status-stopped/12', FOCUS)}
      >
        <X aria-hidden className="size-3" />
      </button>
    </div>
  );
}

export function SidebarFooter({ onShowSettings }: { onShowSettings: () => void }) {
  return (
    <div className="flex-shrink-0">
      <div className="nav-divider" />
      <div className="px-2 py-2">
        <button
          type="button"
          onClick={onShowSettings}
          className={cn(ROW, 'text-ui text-muted-foreground hover:text-foreground')}
        >
          <Settings aria-hidden className="size-3.5" />
          <span>Settings</span>
        </button>
      </div>
    </div>
  );
}
