// The cockpit's navigation (decision cockpit-sidebar-replaces-top-bar): the logo, New session,
// Inbox · Now · Plan, every space with its desks, and Settings with the account at the foot.
import { Brain, ChevronRight, Inbox, KanbanSquare, ListTree, PanelLeftClose, PanelLeftOpen, Pencil, Plus, Settings, X } from 'lucide-react';

import { useAgents } from '@/components/settings/hooks/useAgents';
import { MOD } from '@/components/top-bar/shortcuts';
import { openTaskView } from '@/components/top-bar/useCockpitShortcuts';
import { useAboutInfo } from '@/hooks/useAboutInfo';
import { reset as resetBrainSurface } from '@/lib/brain-nav';
import { usePendingReviews } from '@/lib/queries';
import { useTaskBoard } from '@/lib/task-board';
import { cn } from '@/lib/utils';
import { Count, FOCUS, LABEL, Menu, Monogram, monograms, NAV_ROW, NavItem } from '@/shared/view/ui';
import * as paneStore from '@/stores/usePaneStore';
import { useTaskView, type TaskView } from '@/stores/useTaskViewStore';
import { setTopView, useTopView } from '@/stores/useTopViewStore';

import { useDeskNav, type DeskMark, type Section } from './useDeskNav';

const TASK_VIEWS: Array<{ view: TaskView; label: string; key: string; icon: typeof Inbox }> = [
  { view: 'inbox', label: 'Inbox', key: 'I', icon: Inbox },
  { view: 'now', label: 'Now', key: 'N', icon: KanbanSquare },
  { view: 'plan', label: 'Plan', key: 'P', icon: ListTree },
];

/** A desk's or a folded space's count: grey, or red "!" when a session there stopped with an error. */
function Mark({ mark }: { mark: DeskMark }) {
  if (mark.kind === 'none') return null;
  if (mark.kind === 'stopped') return <Count tone="stopped" label={`${mark.count} session${mark.count === 1 ? '' : 's'} stopped with an error`}>!</Count>;
  return <Count label={`${mark.count} session${mark.count === 1 ? '' : 's'} to look at: finished or asking you`}>{mark.count}</Count>;
}

/** The logo (opens Settings › About), the dev badge, and pin or close. */
export function NavHeader({ pinned, onTogglePinned, onClose, onOpenAbout }: {
  pinned: boolean;
  onTogglePinned?: () => void;
  onClose?: () => void;
  onOpenAbout: () => void;
}) {
  const { info: about } = useAboutInfo();
  return (
    <div className="flex flex-shrink-0 items-center gap-1 px-3 pt-3 pb-2">
      <button
        type="button"
        onClick={onOpenAbout}
        aria-label={about ? `EML Cockpit ${about.version}: about` : 'EML Cockpit: about'}
        title={about ? `EML Cockpit ${about.version}` : 'EML Cockpit'}
        className={cn('grid size-(--target-comfortable) place-items-center rounded-lg text-foreground hover:bg-foreground/8', FOCUS)}
      >
        <Brain aria-hidden className="size-5" strokeWidth={1.8} />
      </button>
      {about?.runMode === 'dev' && (
        <span className="rounded border border-status-you/40 bg-status-you/12 px-1.5 text-caption font-semibold text-you-ink" title={`Development cockpit (${about.version}), not your production cockpit`}>
          DEV
        </span>
      )}
      <span className="flex-1" />
      {onTogglePinned && (
        <button
          type="button"
          onClick={onTogglePinned}
          aria-label={pinned ? 'Collapse sidebar' : 'Keep sidebar open'}
          title={pinned ? 'Collapse sidebar' : 'Keep sidebar open'}
          className={cn('grid size-(--target-comfortable) place-items-center rounded-lg text-muted-foreground hover:bg-foreground/8 hover:text-foreground', FOCUS)}
        >
          {pinned ? <PanelLeftClose aria-hidden className="size-4" /> : <PanelLeftOpen aria-hidden className="size-4" />}
        </button>
      )}
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Close navigation" className={cn('grid size-(--target-touch) place-items-center rounded-lg text-muted-foreground hover:bg-foreground/8', FOCUS)}>
          <X aria-hidden className="size-5" />
        </button>
      )}
    </div>
  );
}

/** Inbox (with what waits for you, amber), Now and Plan. `onNavigate` runs after a pick (the phone's drawer closes). */
export function TaskNav({ onNavigate }: { onNavigate?: () => void }) {
  const { view } = useTaskView();
  const topView = useTopView();
  const inbox = useTaskBoard().data?.counts?.inbox ?? 0;
  return (
    <nav aria-label="Tasks" className="flex flex-col gap-0.5 px-3">
      {TASK_VIEWS.map((t) => (
        <NavItem
          key={t.view}
          icon={t.icon}
          label={t.label}
          title={`${t.label} (G then ${t.key})`}
          current={topView === 'tasks' && view === t.view}
          onClick={() => { openTaskView(t.view); onNavigate?.(); }}
          count={t.view === 'inbox' && inbox > 0 ? <Count tone="you" label={`${inbox} waiting for you`}>{inbox}</Count> : undefined}
        />
      ))}
    </nav>
  );
}

/** Every space as a group you fold open or shut, its desks inside, "+ New desk" at the end. */
export function SpacesNav({ onNavigate }: { onNavigate?: () => void }) {
  const nav = useDeskNav({ shortcuts: true });
  const pendingReviews = usePendingReviews().data?.length ?? 0;
  const letters = monograms(nav.sections.map((s) => s.space?.name ?? 'Brain'));
  let position = 0;

  const openBrain = (section: Section) => {
    onNavigate?.();
    if (nav.topView === 'brain' && section.key === nav.activeSpaceId) { resetBrainSurface('tab'); return; }
    paneStore.activateSpace(section.key);
    setTopView('brain');
  };

  return (
    <nav aria-label="Spaces" className="flex flex-col gap-0.5 px-3">
      <h2 className={cn(LABEL, 'm-0 px-2.5 pt-4 pb-1')}>Spaces</h2>
      {nav.sections.map((section) => {
        const name = section.space?.name ?? 'Brain';
        const unfolded = nav.isUnfolded(section);
        const isActiveSpace = section.key === nav.activeSpaceId;
        const reviews = isActiveSpace ? pendingReviews : 0;
        const spaceDrop = section.space && nav.spaceDrop?.id === section.space.id ? nav.spaceDrop.place : null;
        return (
          <div key={section.space?.id ?? 'all'} role="group" aria-label={name} className="relative flex flex-col gap-0.5" {...(section.space ? nav.spaceDragProps(section.space) : {})}>
            {spaceDrop && <DropLine place={spaceDrop} />}
            <div className="group flex items-center gap-1">
              {section.space && nav.editingId === nav.spaceEditId(section.space) ? (
                <input {...nav.renameInputProps(nav.spaceEditId(section.space))} aria-label="Space name" placeholder="Space name" maxLength={40} className={RENAME} />
              ) : (
                <button
                  type="button"
                  aria-expanded={unfolded}
                  onClick={() => nav.toggleFold(section)}
                  onDoubleClick={() => { if (section.space) nav.startEditing(nav.spaceEditId(section.space), section.space.name); }}
                  title={`${name}: ${unfolded ? 'fold' : 'unfold'} its desks · double-click to rename, drag to reorder the spaces`}
                  className={cn(NAV_ROW, 'gap-2 pl-1 font-semibold')}
                >
                  <ChevronRight aria-hidden className={cn('size-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-(--duration-fast)', unfolded && 'rotate-90')} />
                  <Monogram letters={letters.get(name) ?? '?'} active={isActiveSpace} />
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  {!unfolded && <Mark mark={nav.markOfSection(section)} />}
                </button>
              )}
              <Menu
                label={`${name} actions`}
                className="invisible group-focus-within:visible group-hover:visible aria-expanded:visible"
                items={[
                  { label: reviews > 0 ? `Open its brain · ${reviews} to review` : 'Open its brain', icon: Brain, onSelect: () => openBrain(section) },
                  ...(section.space ? [{ label: 'Rename space', icon: Pencil, onSelect: () => nav.startEditing(nav.spaceEditId(section.space!), section.space!.name) }] : []),
                ]}
              />
            </div>
            {unfolded && (
              <div className="flex flex-col gap-0.5 pl-6">
                {section.desks.map((desk) => {
                  const idx = position++;
                  const key = idx < 9 ? `${MOD}${idx + 1}` : null;
                  const current = nav.isOpenDesk(desk);
                  const drop = nav.dropTarget?.id === desk.id ? nav.dropTarget.place : null;
                  return (
                    <div key={desk.id} {...nav.deskDragProps(desk, section.key)} className={cn('group relative flex items-center', nav.paneDropId === desk.id && 'rounded-lg ring-2 ring-ring')}>
                      {drop && <DropLine place={drop} />}
                      {nav.editingId === desk.id ? (
                        <input {...nav.renameInputProps(desk.id)} aria-label="Desk name" placeholder="Desk name" maxLength={40} className={RENAME} />
                      ) : (
                        <button
                          type="button"
                          aria-current={current ? 'page' : undefined}
                          onClick={() => { nav.openDesk(desk); onNavigate?.(); }}
                          onDoubleClick={() => nav.startEditing(desk.id, desk.name)}
                          title={`${desk.name}${key ? ` (${key})` : ''} · double-click to rename, drag to reorder, drop a pane title here to move the pane`}
                          className={cn(NAV_ROW, 'pr-9')}
                        >
                          <span aria-hidden className={cn('size-1.5 flex-shrink-0 rounded-full', current ? 'bg-foreground' : 'bg-foreground/20')} />
                          <span className="min-w-0 flex-1 truncate">{desk.name}</span>
                          {key && nav.hint && <span aria-hidden className="text-caption text-muted-foreground">{key}</span>}
                          <Mark mark={nav.markOf(desk)} />
                        </button>
                      )}
                      {nav.editingId !== desk.id && (
                        <Menu
                          label={`${desk.name} actions`}
                          className={cn('absolute right-1', !current && 'invisible group-focus-within:visible group-hover:visible aria-expanded:visible')}
                          items={[
                            { label: 'Rename desk', icon: Pencil, onSelect: () => nav.startEditing(desk.id, desk.name) },
                            { label: 'Close desk', icon: X, destructive: true, disabled: section.desks.length <= 1, onSelect: () => nav.closeDesk(desk, section.desks.length) },
                          ]}
                        />
                      )}
                    </div>
                  );
                })}
                <button type="button" onClick={() => nav.createDesk(section)} className={cn(NAV_ROW, 'gap-2 text-muted-foreground hover:text-foreground')}>
                  <Plus aria-hidden className="size-3.5 flex-shrink-0" />
                  New desk
                </button>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

const RENAME = 'min-h-(--target-comfortable) w-full min-w-0 rounded-lg border border-input bg-card px-2.5 text-body text-foreground outline-none focus-visible:outline-2 focus-visible:outline-offset-(--focus-offset) focus-visible:outline-ring';

/** Where a dragged desk or space would land: a line above or below the row. */
function DropLine({ place }: { place: 'before' | 'after' }) {
  return <span aria-hidden className={cn('pointer-events-none absolute inset-x-1 h-0.5 rounded-full bg-foreground', place === 'before' ? '-top-px' : '-bottom-px')} />;
}

/** Settings, then you: your name and the cockpit's version (opens Settings › Account). */
export function NavFooter({ onShowSettings }: { onShowSettings: (tab?: string) => void }) {
  const { name } = useAgents();
  const { info: about } = useAboutInfo();
  return (
    <div className="flex flex-shrink-0 flex-col gap-0.5 border-t border-border px-3 py-2">
      <NavItem icon={Settings} label="Settings" onClick={() => onShowSettings()} />
      <button type="button" onClick={() => onShowSettings('account')} className={cn(NAV_ROW, 'text-muted-foreground')} title="Your account">
        <span aria-hidden className="inline-grid size-6 flex-shrink-0 place-items-center rounded-full bg-foreground text-caption font-bold text-background">
          {(name ?? '?').charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate">
          {name ?? 'You'}
          {about && <span className="tabular-nums"> · v{about.version}</span>}
        </span>
      </button>
    </div>
  );
}

/** The collapsed sidebar: the same places as icons, with their counts. */
export function NavRail({ onOpen, onShowSettings }: { onOpen: () => void; onShowSettings: (tab?: string) => void }) {
  const { view } = useTaskView();
  const nav = useDeskNav();
  const inbox = useTaskBoard().data?.counts?.inbox ?? 0;
  const letters = monograms(nav.sections.map((s) => s.space?.name ?? 'Brain'));
  const RAIL = cn('relative grid size-(--target-comfortable) place-items-center rounded-lg text-muted-foreground hover:bg-foreground/8 hover:text-foreground aria-[current=page]:bg-card aria-[current=page]:text-foreground aria-[current=page]:shadow-card', FOCUS);
  return (
    <div className="flex h-full w-(--size-sidebar-rail) flex-col items-center gap-1 py-3">
      <button type="button" onClick={onOpen} aria-label="Show sidebar" title="Show sidebar" className={RAIL}>
        <PanelLeftOpen aria-hidden className="size-4" />
      </button>
      <button type="button" onClick={onOpen} aria-label="New session" title="New session" className={RAIL}>
        <span aria-hidden className="grid size-6 place-items-center rounded-md bg-foreground text-background"><Plus className="size-4" /></span>
      </button>
      <span aria-hidden className="my-1 h-px w-6 bg-border" />
      {TASK_VIEWS.map((t) => (
        <button key={t.view} type="button" onClick={() => openTaskView(t.view)} aria-label={t.label} title={t.label} aria-current={nav.topView === 'tasks' && view === t.view ? 'page' : undefined} className={RAIL}>
          <t.icon aria-hidden className="size-4" />
          {t.view === 'inbox' && inbox > 0 && <RailDot tone="you" label={`${inbox} waiting for you`} />}
        </button>
      ))}
      <span aria-hidden className="my-1 h-px w-6 bg-border" />
      {nav.sections.map((section) => {
        const name = section.space?.name ?? 'Brain';
        const mark = nav.markOfSection(section);
        return (
          <button key={section.space?.id ?? 'all'} type="button" onClick={onOpen} aria-label={`${name}: show its desks`} title={name} className={RAIL}>
            <Monogram letters={letters.get(name) ?? '?'} active={section.key === nav.activeSpaceId} />
            {mark.kind !== 'none' && <RailDot tone={mark.kind === 'stopped' ? 'stopped' : 'plain'} label={mark.kind === 'stopped' ? 'A session stopped with an error' : `${mark.count} to look at`} />}
          </button>
        );
      })}
      <span className="flex-1" />
      <button type="button" onClick={() => onShowSettings()} aria-label="Settings" title="Settings" className={RAIL}>
        <Settings aria-hidden className="size-4" />
      </button>
    </div>
  );
}

/** On the rail a count is a dot in its colour; the number is in its label. */
function RailDot({ tone, label }: { tone: 'plain' | 'you' | 'stopped'; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn('absolute top-1 right-1 size-2 rounded-full ring-2 ring-card', tone === 'you' ? 'bg-status-you' : tone === 'stopped' ? 'bg-status-stopped' : 'bg-foreground')}
    />
  );
}
