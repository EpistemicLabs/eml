import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSoftKeyboardOpen } from '@/hooks/useSoftKeyboardOpen';
import { APP_HEIGHT_VAR } from '@/hooks/useVisibleViewportHeight';
import { cn } from '@/lib/utils';
import type { SidebarDrawer, SidebarProps } from '../types';
import { useSidebarController } from '../useSidebarController';
import { RowMenuContext, type RowMenuApi, type RowMenuTarget } from './rowMenuContext';
import { SidebarErrorLine, SidebarFooter, SidebarHeader, SidebarModes, SidebarRail } from './subcomponents/SidebarChrome';
import { SidebarAllSessions, useWaitingCount } from './subcomponents/SidebarAllSessions';
import { SidebarNewSession } from './subcomponents/SidebarNewSession';
import { SidebarConversations } from './subcomponents/SidebarConversations';
import { SidebarModals } from './subcomponents/SidebarModals';
import { SidebarProjectTree } from './subcomponents/SidebarProjectTree';
import { SidebarRowMenu } from './subcomponents/SidebarRowMenu';
import { SidebarScrollRegion } from './subcomponents/SidebarScrollRegion';

const CLOSE_GRACE_MS = 200;

export default function Sidebar({ drawer, ...props }: SidebarProps & { drawer?: SidebarDrawer }) {
  const controller = useSidebarController(props);
  const keyboardOpen = useSoftKeyboardOpen();
  const [menuTarget, setMenuTarget] = useState<{ target: RowMenuTarget; row: DOMRect | null } | null>(null);
  const { isSessionPinned } = controller;
  const rowMenu = useMemo<RowMenuApi>(() => ({
    open: (target, row) => setMenuTarget({ target, row: row?.getBoundingClientRect() ?? null }),
    isSessionPinned,
  }), [isSessionPinned]);

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

  const isOpen =
    controller.isPinnedOpen || hovered || controller.projectRename !== null || controller.sessionRename !== null;
  // All spaces reaches only the overview: projects and conversations are the open space's.
  const onlyOpenSpace = !controller.allView;
  const waiting = useWaitingCount(controller, onlyOpenSpace);

  const panel = (
    <>
      <SidebarHeader
        isPinnedOpen={controller.isPinnedOpen}
        onTogglePinned={drawer ? undefined : controller.togglePinnedOpen}
      />
      <SidebarNewSession controller={controller} />
      <SidebarModes viewMode={controller.viewMode} onViewModeChange={controller.setViewMode} waiting={waiting} />
      <SidebarErrorLine error={controller.error} onDismiss={controller.dismissError} />
      <SidebarScrollRegion
        refreshing={controller.refreshing}
        isRefreshInFlight={() => controller.refreshingRef.current}
        onRefresh={() => void controller.runManualRefresh()}
      >
        {controller.viewMode === 'overview' ? (
          <SidebarAllSessions controller={controller} onlyOpenSpace={onlyOpenSpace} />
        ) : controller.viewMode === 'conversations' ? (
          <SidebarConversations controller={controller} />
        ) : (
          <SidebarProjectTree controller={controller} />
        )}
      </SidebarScrollRegion>
      <SidebarFooter onShowSettings={controller.onShowSettings} />
    </>
  );

  // Compact layout: no rail and no hover; the panel slides in over the page
  // and a tap beside it closes it again.
  if (drawer) {
    return (
      <>
        <SidebarModals controller={controller} />
        {menuTarget && <SidebarRowMenu target={menuTarget.target} row={menuTarget.row} controller={controller} onClose={() => setMenuTarget(null)} />}
        <div
          data-sidebar-drawer
          className={cn(
            'fixed inset-0 z-50 bg-black/40 transition-opacity duration-200',
            drawer.open ? 'opacity-100' : 'pointer-events-none opacity-0',
          )}
          aria-hidden
          onClick={drawer.onClose}
        />
        <div
          role="dialog"
          aria-label="Projects and sessions"
          aria-hidden={!drawer.open}
          inert={!drawer.open}
          data-sidebar-drawer
          // Sized to the visible viewport like the app: searching raises the keyboard, which would cover its lower part.
          style={{ height: `var(${APP_HEIGHT_VAR}, 100dvh)` }}
          className={cn(
            'fixed top-0 left-0 z-50 flex w-[min(20rem,85vw)] flex-col border-r border-border bg-popover select-none',
            // Off screen its shadow would still fall on the page's left edge.
            drawer.open && 'shadow-2xl',
            'pt-[env(safe-area-inset-top)] transition-transform duration-200 [-webkit-touch-callout:none]',
            !keyboardOpen && 'pb-[env(safe-area-inset-bottom)]',
            drawer.open ? 'translate-x-0' : '-translate-x-full',
          )}
        >
          <RowMenuContext.Provider value={rowMenu}>{panel}</RowMenuContext.Provider>
        </div>
      </>
    );
  }

  return (
    <>
      <SidebarModals controller={controller} />
      <div className={cn('relative h-full', controller.isPinnedOpen ? 'w-68' : 'w-12')}>
        <div
          onMouseEnter={openPanel}
          onMouseLeave={scheduleClose}
          className={cn(
            'absolute top-0 left-0 z-50 h-full overflow-hidden rounded-xl transition-[width] duration-200',
            isOpen
              ? 'w-68 border border-border bg-popover shadow-2xl'
              : 'frosted w-12 shadow-md',
          )}
        >
          <div
            className={cn(
              'absolute top-0 left-0 h-full w-12 transition-opacity duration-150',
              isOpen ? 'pointer-events-none opacity-0' : 'opacity-100',
            )}
          >
            <SidebarRail onOpen={openPanel} />
          </div>
          <div
            className={cn(
              'absolute top-0 left-0 flex h-full w-68 flex-col select-none transition-[opacity,visibility] duration-150',
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
