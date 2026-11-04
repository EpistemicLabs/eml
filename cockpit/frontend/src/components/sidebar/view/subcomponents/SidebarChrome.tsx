import { PanelLeftOpen, Pin, PinOff, Settings, X } from 'lucide-react';

import SpaceSwitch from '@/components/app/SpaceSwitch';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/view/ui';
import type { SidebarError, SidebarViewMode } from '../../types';

export function SidebarRail({ onOpen }: { onOpen: () => void }) {
  return (
    <div className="flex h-full w-12 flex-col items-center bg-background/60 py-2 backdrop-blur-sm">
      <button
        type="button"
        aria-label="Show sidebar"
        title="Show sidebar"
        onClick={onOpen}
        className="group flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
      >
        <PanelLeftOpen className="h-4 w-4 text-muted-foreground transition-colors group-hover:text-foreground" />
      </button>
    </div>
  );
}

const MODES: Array<{ mode: SidebarViewMode; label: string }> = [
  { mode: 'overview', label: 'Overview' },
  { mode: 'projects', label: 'Projects' },
  { mode: 'conversations', label: 'Sessions' },
];

/** The sidebar's three views, under the space switch; the overview is still in beta. */
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
    <div role="tablist" aria-label="Sidebar view" className="flex flex-shrink-0 gap-0.5 px-2 pb-1">
      {MODES.map(({ mode, label }) => {
        const active = viewMode === mode;
        return (
          <button
            key={mode}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onViewModeChange(mode)}
            className={cn(
              'flex h-7 min-w-0 flex-auto items-center justify-center gap-1 rounded-md px-1.5 text-[11px] font-medium transition-colors',
              active ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
            )}
          >
            <span className="truncate">{label}</span>
            {mode === 'overview' && (
              <span className="rounded border border-border px-1 text-[9px] leading-tight font-normal text-muted-foreground" title="Beta">
                β
              </span>
            )}
            {mode === 'overview' && !active && waiting > 0 && (
              <span className="rounded-full bg-foreground px-1.5 text-[10px] leading-4 text-background tabular-nums" aria-label={`${waiting} waiting`}>
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
            size="sm"
            className={cn(
              'h-7 w-7 p-0 [&_svg]:size-3.5',
              isPinnedOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
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
      className="mx-2 mb-1 flex flex-shrink-0 items-start gap-2 rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive"
    >
      <span className="min-w-0 flex-1 break-words">{error.message}</span>
      <button
        type="button"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
        className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded text-destructive/80 transition-colors hover:bg-destructive/10 hover:text-destructive"
      >
        <X className="h-3 w-3" />
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
          className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        >
          <Settings className="h-3.5 w-3.5" />
          <span className="text-xs">Settings</span>
        </button>
      </div>
    </div>
  );
}
