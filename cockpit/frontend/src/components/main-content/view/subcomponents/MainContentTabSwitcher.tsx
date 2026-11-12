// Adapted: the views come from lib/pane-views.ts, in two groups — the
// session's (Terminal, Chat) and the plugins (Brain and the ones switched on).
// Trimmed: additive sub-pane toggles (Files / Source Control), i18n.
import { Fragment, useEffect, useRef, useState } from 'react';
import { PanelLeft, Plus, X, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import Tooltip from '@/shared/view/ui/Tooltip';
import { PANE_VIEW_DEFS, useViewEnabled, type PaneViewDef } from '@/lib/pane-views';
import { newSessionEntries, useProviders } from '@/lib/providers';
import type { PaneView } from '@/stores/usePaneStore';
import type { LLMProvider } from '@/types/app';

type MainContentTabSwitcherProps = {
  paneView: PaneView;
  onSetPaneView: (view: PaneView) => void;
  // Optional pane-close affordance. When provided, an × icon is rendered
  // at the right of the toolbar in the same naked icon style. Undefined
  // hides it (e.g. the last remaining pane).
  onClosePane?: () => void;
  // Cockpit: "+" next to the close action opens a new
  // pane to the right of this one — Terminal or Brain, asked via a tiny menu
  // because a terminal pane spawns an agent session the moment it mounts.
  // With more than one agent CLI set up, the menu offers a session per CLI
  // (like the sidebar's "+"); `provider` is then the chosen one.
  onAddPane?: (view: PaneView, provider?: LLMProvider) => void;
  // This pane is its desk's main pane; the toggle makes it one, or ends that.
  isMainPane?: boolean;
  onToggleMainPane?: () => void;
  // A terminal/chat handoff is under way: why those two can't be switched now.
  switchBlocked?: string | null;
};

const GROUPS = [
  { group: 'session', title: 'Sessions' },
  { group: 'plugin', title: 'Plugins' },
] as const;

const TO_TERMINAL_HINT = 'Terminal: stops a running turn; background tasks and session grants do not carry over';

/**
 * Apple-style toolbar: a Segmented Control for the pane's view mode
 * (mutually exclusive, grouped: session views │ plugins). Active segment gets a subtle
 * frosted background highlight on top of a shared pill. A dezenter divider
 * separates it from the pane-level close action.
 */
export default function MainContentTabSwitcher({
  paneView,
  onSetPaneView,
  onClosePane,
  onAddPane,
  isMainPane = false,
  onToggleMainPane,
  switchBlocked = null,
}: MainContentTabSwitcherProps) {
  const closeLabel = 'Close this pane';
  const addLabel = 'New pane next to this one';
  const [addOpen, setAddOpen] = useState(false);
  const sessionEntries = newSessionEntries(useProviders().data ?? []);
  const enabled = useViewEnabled();
  // Mutually exclusive: each view swaps the pane's body.
  const modes = PANE_VIEW_DEFS.filter((mode) => enabled(mode.view));
  type AddItem = { key: string; label: string; icon: LucideIcon; view: PaneView; provider?: LLMProvider };
  // Same wording as the sidebar's "+" menu (SidebarProjectNotes NewPaneButton);
  // terminal entries come from newSessionEntries, one per ready agent CLI.
  const addItems = (group: PaneViewDef['group']): AddItem[] =>
    modes.filter((mode) => mode.group === group).flatMap((mode): AddItem[] =>
      mode.view === 'terminal'
        ? sessionEntries.map(({ label, provider }) => ({
            key: provider ? `terminal-${provider}` : 'terminal', label, icon: mode.icon, view: mode.view, provider,
          }))
        : [{ key: mode.view, label: mode.newLabel, icon: mode.icon, view: mode.view }]);
  const addRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!addOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!addRef.current?.contains(event.target as Node)) setAddOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setAddOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [addOpen]);

  return (
    <div className="flex items-center gap-2">
      {/* View-mode segmented control, one pill per group: the session's views │ the plugins. */}
      <div role="radiogroup" className="flex items-center gap-1.5">
        {GROUPS.map(({ group }) => (
          <div key={group} className="flex items-center gap-0.5 rounded-md bg-foreground/10 p-0.5 ring-1 ring-foreground/10">
            {modes.filter((mode) => mode.group === group).map((mode) => {
              const isActive = paneView === mode.view;
              const blocked = !isActive && !!switchBlocked && mode.group === 'session';
              return (
                <Tooltip key={mode.view} content={blocked ? switchBlocked : paneView === 'chat' && mode.view === 'terminal' ? TO_TERMINAL_HINT : mode.label} position="bottom">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={mode.label}
                    disabled={blocked}
                    onClick={() => onSetPaneView(mode.view)}
                    className={cn(
                      'flex h-6 w-7 items-center justify-center rounded transition-colors duration-150 disabled:opacity-40',
                      isActive
                        ? 'bg-foreground/20 text-foreground shadow-sm'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    <mode.icon className="h-3.5 w-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>

      {(onAddPane || onClosePane || onToggleMainPane) && <div className="h-5 w-px bg-foreground/15" aria-hidden="true" />}

      {onToggleMainPane && (
        <Tooltip content={isMainPane ? 'Main pane: back to the even grid (can then be closed)' : 'Make main pane'} position="bottom">
          <button
            type="button"
            onClick={onToggleMainPane}
            aria-label={isMainPane ? 'Stop being the main pane' : 'Make main pane'}
            aria-pressed={isMainPane}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground',
              isMainPane ? 'bg-foreground/10 text-foreground' : 'text-muted-foreground/80',
            )}
          >
            <PanelLeft className="h-4 w-4" strokeWidth={isMainPane ? 2.2 : 1.8} />
          </button>
        </Tooltip>
      )}

      {onAddPane && (
        <div ref={addRef} className="relative">
          {/* No hover tooltip: it covered the menu's first item. */}
          <button
            type="button"
            onClick={() => setAddOpen((open) => !open)}
            aria-label={addLabel}
            aria-haspopup="menu"
            aria-expanded={addOpen}
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/80 transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground',
              addOpen && 'bg-foreground/5 text-foreground',
            )}
          >
            <Plus className="h-4 w-4" strokeWidth={1.8} />
          </button>
          {addOpen && (
            <div
              role="menu"
              className="absolute top-full right-0 z-40 mt-1 min-w-[10rem] rounded-md border border-foreground/20 bg-muted p-1 shadow-[0_8px_24px_rgba(0,0,0,0.14)] ring-1 dark:shadow-[0_8px_24px_rgba(0,0,0,0.6)] ring-black/5 dark:ring-black/40"
            >
              {GROUPS.map(({ group, title }, index) => (
                <Fragment key={group}>
                  <div className={cn('px-2 pb-0.5 text-[11px] font-medium text-muted-foreground', index > 0 ? 'mt-1 border-t border-foreground/10 pt-1.5' : 'pt-1')}>
                    {title}
                  </div>
                  {addItems(group).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      onClick={() => { setAddOpen(false); onAddPane(item.view, item.provider); }}
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-ui whitespace-nowrap text-foreground transition-colors hover:bg-foreground/10"
                    >
                      <item.icon className="h-3.5 w-3.5 text-foreground/80" strokeWidth={1.8} />
                      {item.label}
                    </button>
                  ))}
                </Fragment>
              ))}
            </div>
          )}
        </div>
      )}

      {onClosePane && (
        <>
          <Tooltip content={closeLabel} position="bottom">
            <button
              type="button"
              onClick={onClosePane}
              aria-label={closeLabel}
              data-pane-close
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground/80 transition-colors duration-150 hover:bg-foreground/5 hover:text-foreground"
            >
              <X className="h-4 w-4" strokeWidth={1.8} />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}
