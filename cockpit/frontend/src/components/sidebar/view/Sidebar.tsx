import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import type { SidebarProps } from '../types';
import { useSidebarController } from '../useSidebarController';
import { SidebarErrorLine, SidebarFooter, SidebarHeader, SidebarRail } from './subcomponents/SidebarChrome';
import { SidebarConversations } from './subcomponents/SidebarConversations';
import { SidebarModals } from './subcomponents/SidebarModals';
import { SidebarProjectTree } from './subcomponents/SidebarProjectTree';
import { SidebarScrollRegion } from './subcomponents/SidebarScrollRegion';

const CLOSE_GRACE_MS = 200;

export default function Sidebar(props: SidebarProps) {
  const controller = useSidebarController(props);

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
  const showModes = controller.projects.length > 0 && !controller.isLoading;

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
            <SidebarHeader
              showModes={showModes}
              viewMode={controller.viewMode}
              onViewModeChange={controller.setViewMode}
              isPinnedOpen={controller.isPinnedOpen}
              onTogglePinned={controller.togglePinnedOpen}
              onAddProject={controller.openWizard}
            />
            <SidebarErrorLine error={controller.error} onDismiss={controller.dismissError} />
            <SidebarScrollRegion
              refreshing={controller.refreshing}
              isRefreshInFlight={() => controller.refreshingRef.current}
              onRefresh={() => void controller.runManualRefresh()}
            >
              {controller.viewMode === 'conversations' ? (
                <SidebarConversations controller={controller} />
              ) : (
                <SidebarProjectTree controller={controller} />
              )}
            </SidebarScrollRegion>
            <SidebarFooter onShowSettings={controller.onShowSettings} />
          </div>
        </div>
      </div>
    </>
  );
}
