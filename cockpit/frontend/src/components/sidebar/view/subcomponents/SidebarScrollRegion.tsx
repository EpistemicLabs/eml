import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ScrollArea } from '@/shared/view/ui';

const PULL_THRESHOLD = 60;
const PULL_DAMPING = 0.5;
const PULL_MAX = 100;
const REFRESHING_HEIGHT = 28;

export function SidebarScrollRegion({
  refreshing,
  isRefreshInFlight,
  onRefresh,
  children,
}: {
  refreshing: boolean;
  /** Read at release time so a refresh started meanwhile is not doubled. */
  isRefreshInFlight: () => boolean;
  onRefresh: () => void;
  children: ReactNode;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const startY = useRef<number | null>(null);
  const [distance, setDistance] = useState(0);
  const [pulling, setPulling] = useState(false);

  const reset = () => {
    startY.current = null;
    setPulling(false);
    setDistance(0);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if ((scrollerRef.current?.scrollTop ?? 0) > 0) return;
    startY.current = event.clientY;
    setPulling(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (startY.current === null) return;
    if (event.pointerType === 'mouse' && event.buttons === 0) {
      reset();
      return;
    }
    const delta = event.clientY - startY.current;
    setDistance(delta > 0 ? Math.min(delta * PULL_DAMPING, PULL_MAX) : 0);
  };

  const onPointerEnd = () => {
    if (startY.current !== null && distance >= PULL_THRESHOLD && !isRefreshInFlight()) onRefresh();
    reset();
  };

  const height = refreshing ? REFRESHING_HEIGHT : distance;
  const spinning = refreshing || distance >= PULL_THRESHOLD;

  return (
    <ScrollArea
      ref={scrollerRef}
      className="min-h-0 flex-1 [&>div]:overscroll-contain [&>div]:py-1 [&>div]:pr-3 [&>div]:pl-1.5"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div
        aria-hidden
        className={cn(
          'flex items-center justify-center overflow-hidden',
          !pulling && 'transition-[height] duration-200',
        )}
        style={{ height }}
      >
        <RefreshCw
          className={cn('h-3.5 w-3.5 text-muted-foreground', spinning && 'animate-spin')}
          style={{ opacity: refreshing ? 1 : Math.min(distance / PULL_THRESHOLD, 1) }}
        />
      </div>
      {children}
    </ScrollArea>
  );
}
