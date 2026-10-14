import { Folder, MessageSquare, PanelLeftOpen, Pin, PinOff, Plus, Settings, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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

function ModeButton({
  label,
  icon: Icon,
  active,
  onSelect,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
      )}
    >
      <Icon className="h-3.5 w-3.5" strokeWidth={active ? 2.25 : 2} />
    </button>
  );
}

export function SidebarHeader({
  showModes,
  viewMode,
  onViewModeChange,
  isPinnedOpen,
  onTogglePinned,
  onAddProject,
}: {
  showModes: boolean;
  viewMode: SidebarViewMode;
  onViewModeChange: (mode: SidebarViewMode) => void;
  isPinnedOpen: boolean;
  onTogglePinned: () => void;
  onAddProject: () => void;
}) {
  return (
    <div className="flex flex-shrink-0 items-center justify-between px-3 pt-3 pb-2">
      {showModes ? (
        <div className="flex items-center gap-0.5">
          <ModeButton
            label="Projects"
            icon={Folder}
            active={viewMode === 'projects'}
            onSelect={() => onViewModeChange('projects')}
          />
          <ModeButton
            label="Conversations"
            icon={MessageSquare}
            active={viewMode === 'conversations'}
            onSelect={() => onViewModeChange('conversations')}
          />
        </div>
      ) : (
        <div />
      )}
      <div className="flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground [&_svg]:size-3.5"
          title="Add project"
          onClick={onAddProject}
        >
          <Plus />
        </Button>
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
