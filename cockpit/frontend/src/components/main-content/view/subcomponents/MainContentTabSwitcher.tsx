// Adapted: the views come from lib/pane-views.ts, in two groups — the
// session's (its chat) and the plugins switched on; a group with none shows no pill.
// The "+" menu's sessions are the agent picker's (components/agent-picker): a new chat per agent and model.
// The ··· menu holds the session's terminal fallback while it is on (lib/terminal-fallback.ts).
// Trimmed: additive sub-pane toggles (Files / Source Control), i18n.
import { Fragment, useEffect, useRef, useState } from 'react';
import { PanelLeft, Plus, SquareTerminal, X, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { buttonVariants, LABEL, Menu, POPOVER, ROW, TAB, TRACK } from '@/shared/view/ui';
import Tooltip from '@/shared/view/ui/Tooltip';
import { PANE_VIEW_DEFS, useViewEnabled, type PaneViewDef } from '@/lib/pane-views';
import { useAgentChoice } from '@/components/agent-picker/AgentPicker';
import { newSessionLabel, useProviders } from '@/lib/providers';
import { useTerminalFallback } from '@/lib/terminal-fallback';
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
  // pane to the right of this one — a session or a plugin, asked via a tiny menu
  // because a session pane starts its agent the moment it mounts.
  // The sessions are a new chat per agent with a chat, and per model it offers;
  // `provider` and `model` are then the chosen ones (model null: the agent's default).
  // An agent without a chat is offered only while the terminal fallback is on, and
  // opens in it (`terminalFallback`).
  onAddPane?: (view: PaneView, provider?: LLMProvider, model?: string | null, terminalFallback?: boolean) => void;
  // This pane is its desk's main pane; the toggle makes it one, or ends that.
  isMainPane?: boolean;
  onToggleMainPane?: () => void;
  // A handoff of the session is under way: why its view can't be switched now.
  switchBlocked?: string | null;
  // Which groups of views it offers: outside a pane none or only the session's own.
  groups?: ReadonlyArray<PaneViewDef['group']>;
  // The session's terminal fallback, while it is on or the pane shows it: the ··· menu's one action.
  fallback?: { label: string; run: () => void } | null;
};

const GROUPS = [
  { group: 'session', title: 'Sessions' },
  { group: 'plugin', title: 'Plugins' },
] as const;

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
  groups = ['session', 'plugin'],
  fallback = null,
}: MainContentTabSwitcherProps) {
  const closeLabel = 'Close this pane';
  const addLabel = 'New pane next to this one';
  const [addOpen, setAddOpen] = useState(false);
  const providers = useProviders().data ?? [];
  const fallbackOn = useTerminalFallback();
  // A toolbar without "+" (a task's panel) offers no session: it asks for no model list.
  const agents = useAgentChoice({ models: !!onAddPane }).groups;
  const enabled = useViewEnabled();
  // Mutually exclusive: each view swaps the pane's body.
  const modes = PANE_VIEW_DEFS.filter((mode) => enabled(mode.view) && groups.includes(mode.group));
  // The offered groups that still have a view switched on.
  const shown = GROUPS.filter(({ group }) => modes.some((mode) => mode.group === group));
  type AddItem = { key: string; label: string; icon: LucideIcon | null; view: PaneView; provider?: LLMProvider; model?: string | null; note?: string | null; terminalFallback?: boolean };
  // Sessions: per agent with a chat a new chat with its default model, then one per model it
  // offers, indented under it. While the terminal fallback is on, an agent without a chat too,
  // in the fallback terminal (none today).
  const chatIcon = PANE_VIEW_DEFS.find((mode) => mode.view === 'chat')?.icon ?? null;
  const agentItems: AddItem[] = agents.flatMap((agent) => agent.entries.map((entry, index): AddItem => ({
    key: `chat-${entry.value}`,
    label: index === 0 ? `New ${agent.label} chat` : entry.modelLabel ?? entry.label,
    icon: index === 0 ? chatIcon : null,
    view: 'chat',
    provider: entry.choice.provider as LLMProvider,
    model: entry.choice.model,
    note: index === 0 ? agent.note : null,
  })));
  const fallbackItems: AddItem[] = fallbackOn
    ? providers
      .filter((provider) => provider.version !== null && provider.capabilities?.chat.supported === false)
      .map((provider) => ({ key: `fallback-${provider.id}`, label: `${newSessionLabel(provider)} (terminal fallback)`, icon: SquareTerminal, view: 'chat', provider: provider.id, terminalFallback: true }))
    : [];
  const addItems = (group: PaneViewDef['group']): AddItem[] =>
    group === 'session'
      ? [...agentItems, ...fallbackItems]
      : modes.filter((mode) => mode.group === group).map((mode): AddItem => ({ key: mode.view, label: mode.newLabel, icon: mode.icon, view: mode.view }));
  // The "+" menu leaves out a group with nothing to open (no agent with a chat set up).
  const addGroups = shown.filter(({ group }) => addItems(group).length > 0);
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
      {shown.length > 0 && <div role="radiogroup" className="flex items-center gap-1.5">
        {shown.map(({ group }) => (
          <div key={group} className={cn(TRACK, 'bg-foreground/8')}>
            {modes.filter((mode) => mode.group === group).map((mode) => {
              const isActive = paneView === mode.view;
              const blocked = !isActive && !!switchBlocked && mode.group === 'session';
              return (
                <Tooltip key={mode.view} content={blocked ? switchBlocked : mode.label} position="bottom">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    aria-label={mode.label}
                    disabled={blocked}
                    onClick={() => onSetPaneView(mode.view)}
                    className={cn(TAB, 'px-2 transition-colors duration-(--duration-fast) disabled:opacity-40 aria-checked:bg-card aria-checked:text-foreground aria-checked:shadow-(--shadow-pill)')}
                  >
                    <mode.icon aria-hidden className="size-3.5" strokeWidth={isActive ? 2.2 : 1.8} />
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ))}
      </div>}

      {shown.length > 0 && (onAddPane || onClosePane || onToggleMainPane || fallback) && <div className="h-5 w-px bg-border" aria-hidden="true" />}

      {fallback && (
        <Menu
          label="More session actions"
          className="size-(--size-tab) rounded-(--radius-tab)"
          items={[{ label: fallback.label, icon: SquareTerminal, onSelect: fallback.run }]}
        />
      )}

      {onToggleMainPane && (
        <Tooltip content={isMainPane ? 'Main pane: back to the even grid (can then be closed)' : 'Make main pane'} position="bottom">
          <button
            type="button"
            onClick={onToggleMainPane}
            aria-label={isMainPane ? 'Stop being the main pane' : 'Make main pane'}
            aria-pressed={isMainPane}
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'size-(--size-tab) rounded-(--radius-tab)', isMainPane && 'bg-muted text-foreground')}
          >
            <PanelLeft aria-hidden className="size-4" strokeWidth={isMainPane ? 2.2 : 1.8} />
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
            className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'size-(--size-tab) rounded-(--radius-tab)', addOpen && 'bg-muted text-foreground')}
          >
            <Plus aria-hidden className="size-4" strokeWidth={1.8} />
          </button>
          {addOpen && (
            <div
              role="menu"
              className={cn(POPOVER, 'absolute top-full right-0 mt-1 max-h-80 min-w-(--size-menu-min) overflow-y-auto')}
            >
              {addGroups.map(({ group, title }, index) => (
                <Fragment key={group}>
                  <div className={cn(LABEL, 'px-2 pb-0.5', index > 0 ? 'mt-1 border-t border-border pt-1.5' : 'pt-1')}>
                    {title}
                  </div>
                  {addItems(group).map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      role="menuitem"
                      onClick={() => { setAddOpen(false); onAddPane(item.view, item.provider, item.model, item.terminalFallback); }}
                      className={cn(ROW, 'py-1 whitespace-nowrap', !item.icon && 'pl-7.5 text-ui text-muted-foreground hover:text-foreground')}
                    >
                      {item.icon && <item.icon aria-hidden className="size-3.5 text-muted-foreground" strokeWidth={1.8} />}
                      {item.label}
                      {item.note && <span className="text-ui text-muted-foreground">· {item.note}</span>}
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
              className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'size-(--size-tab) rounded-(--radius-tab)')}
            >
              <X aria-hidden className="size-4" strokeWidth={1.8} />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}
