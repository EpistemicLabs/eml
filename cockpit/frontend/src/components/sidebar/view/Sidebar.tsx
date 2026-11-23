import { useCallback, useEffect, useRef, useState } from 'react';

import { useSoftKeyboardOpen } from '@/hooks/useSoftKeyboardOpen';
import { APP_HEIGHT_VAR } from '@/hooks/useVisibleViewportHeight';
import { cn } from '@/lib/utils';
import { NavFooter, NavHeader, NavRail, SearchTasks, SpacesNav, TaskNav } from '../nav/SidebarNav';
import type { SidebarDrawer, SidebarProps } from '../types';
import { useSidebarState } from '../useSidebarState';
import { SidebarErrorLine } from './subcomponents/SidebarChrome';
import { SidebarNewSession } from './subcomponents/SidebarNewSession';

const CLOSE_GRACE_MS = 200;

/**
 * The cockpit's one navigation (decision cockpit-sidebar-replaces-top-bar): pinned open, or a rail
 * that opens over the panes while the pointer is on it; on a phone, a drawer the page opens.
 */
export default function Sidebar({ drawer, onShowSettings }: SidebarProps & { drawer?: SidebarDrawer }) {
  const controller = useSidebarState();
  const keyboardOpen = useSoftKeyboardOpen();

  const [hovered, setHovered] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const openPanel = useCallback(() => {
    cancelClose();
    setHovered(true);
  }, [cancelClose]);
  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setHovered(false);
    }, CLOSE_GRACE_MS);
  }, [cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  const isOpen = controller.isPinnedOpen || hovered;
  const showSettings = onShowSettings;

  const panel = (
    <>
      <NavHeader
        pinned={controller.isPinnedOpen}
        onTogglePinned={drawer ? undefined : controller.togglePinnedOpen}
        onClose={drawer?.onClose}
        onOpenAbout={() => showSettings('about')}
      />
      <SidebarNewSession onError={controller.reportError} />
      <SearchTasks onNavigate={drawer?.onClose} />
      <SidebarErrorLine error={controller.error} onDismiss={controller.dismissError} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        <TaskNav onNavigate={drawer?.onClose} />
        <SpacesNav onNavigate={drawer?.onClose} />
      </div>
      <NavFooter onShowSettings={showSettings} />
    </>
  );

  // Phone: no rail and no hover; the panel slides in over the page and a tap beside it closes it.
  if (drawer) {
    return (
      <>
        <div
          data-sidebar-drawer
          className={cn(
            'fixed inset-0 z-(--z-modal) bg-(--scrim) transition-opacity duration-(--duration-fast)',
            drawer.open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          aria-hidden
          onClick={drawer.onClose}
        />
        <div
          role="dialog"
          aria-label="Navigation"
          aria-hidden={!drawer.open}
          inert={!drawer.open}
          data-sidebar-drawer
          // Sized to the visible viewport like the app: a raised keyboard would cover its lower part.
          style={{ height: `var(${APP_HEIGHT_VAR}, 100dvh)` }}
          className={cn(
            'fixed top-0 left-0 z-(--z-modal) flex w-(--size-sidebar-drawer) flex-col border-r border-border bg-background select-none',
            // Off screen its shadow would still fall on the page's left edge.
            drawer.open && 'shadow-modal',
            'pt-[env(safe-area-inset-top)] transition-transform duration-(--duration-fast) [-webkit-touch-callout:none]',
            !keyboardOpen && 'pb-[env(safe-area-inset-bottom)]',
            drawer.open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          {panel}
        </div>
      </>
    );
  }

  return (
    <>
      <div className={cn('relative h-full', controller.isPinnedOpen ? 'w-(--size-sidebar)' : 'w-(--size-sidebar-rail)')}>
        <div
          onMouseEnter={openPanel}
          onMouseLeave={scheduleClose}
          className={cn(
            'absolute top-0 left-0 z-(--z-modal) h-full overflow-hidden rounded-xl transition-[width] duration-(--duration-fast)',
            isOpen ? 'glass-thick w-(--size-sidebar)' : 'glass w-(--size-sidebar-rail)',
          )}
        >
          <div
            className={cn(
              'absolute top-0 left-0 h-full w-(--size-sidebar-rail) transition-opacity duration-(--duration-fast)',
              isOpen ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
            <NavRail onOpen={openPanel} onShowSettings={showSettings} />
          </div>
          <div
            className={cn(
              'absolute top-0 left-0 flex h-full w-(--size-sidebar) flex-col select-none transition-[opacity,visibility] duration-(--duration-fast)',
              isOpen ? 'opacity-100' : 'pointer-events-none invisible opacity-0',
            )}
          >
            {panel}
          </div>
        </div>
      </div>
    </>
  );
}
