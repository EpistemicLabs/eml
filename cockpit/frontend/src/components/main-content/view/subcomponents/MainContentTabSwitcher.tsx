// Adapted: VIEW_MODES = terminal | brain (decision cockpit-pane-types).
// Trimmed: additive sub-pane toggles (Files / Source Control), i18n.
import { useEffect, useRef, useState } from 'react';
import { Brain, MessageSquare, NotebookPen, Plus, Terminal, X, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import Tooltip from '@/shared/view/ui/Tooltip';
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
  // A terminal/chat handoff is under way: why those two can't be switched now.
  switchBlocked?: string | null;
};

type ViewModeDef = {
  view: PaneView;
  label: string;
  icon: LucideIcon;
};

// Mutually exclusive: Terminal ↔ Chat ↔ Brain ↔ Note swap the pane's body.
const VIEW_MODES: ViewModeDef[] = [
  { view: 'terminal', label: 'Terminal', icon: Terminal },
  { view: 'chat', label: 'Chat', icon: MessageSquare },
  { view: 'brain', label: 'Brain', icon: Brain },
  { view: 'note', label: 'Note', icon: NotebookPen },
];

// Same wording as the sidebar's "+" menu (SidebarProjectNotes NewPaneButton);
// terminal entries come from newSessionEntries.
const NEW_LABEL: Record<Exclude<PaneView, 'terminal'>, string> = { chat: 'New chat session', brain: 'New brain view', note: 'New note' };

const TO_TERMINAL_HINT = 'Terminal: stops a running turn; background tasks and session grants do not carry over';

/**
 * Apple-style toolbar: a Segmented Control for the pane's view mode
 * (Terminal or Brain — mutually exclusive). Active segment gets a subtle
 * frosted background highlight on top of a shared pill. A dezenter divider
 * separates it from the pane-level close action.
 */
export default function MainContentTabSwitcher({
  paneView,
  onSetPaneView,
  onClosePane,
  onAddPane,
  switchBlocked = null,
}: MainContentTabSwitcherProps) {
  const closeLabel = 'Close this pane';
  const addLabel = 'New pane next to this one';
  const [addOpen, setAddOpen] = useState(false);
  const sessionEntries = newSessionEntries(useProviders().data ?? []);
  type AddItem = { key: string; label: string; icon: LucideIcon; view: PaneView; provider?: LLMProvider };
  const addItems: AddItem[] =
    VIEW_MODES.flatMap((mode): AddItem[] =>
      mode.view === 'terminal'
        ? sessionEntries.map(({ label, provider }) => ({
            key: provider ? `terminal-${provider}` : 'terminal', label, icon: mode.icon, view: mode.view, provider,
          }))
        : [{ key: mode.view, label: NEW_LABEL[mode.view], icon: mode.icon, view: mode.view }]);
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
      {/* View-mode segmented control: Terminal / Brain */}
      <div
        role="radiogroup"
        className="flex items-center gap-0.5 rounded-md bg-foreground/10 p-0.5 ring-1 ring-foreground/10"
      >
        {VIEW_MODES.map((mode) => {
          const isActive = paneView === mode.view;
          const blocked = !isActive && !!switchBlocked && (mode.view === 'terminal' || mode.view === 'chat');
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

      {(onAddPane || onClosePane) && <div className="h-5 w-px bg-foreground/15" aria-hidden="true" />}

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
              {addItems.map((item) => (
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
