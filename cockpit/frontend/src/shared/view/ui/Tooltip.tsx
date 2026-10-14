import * as React from 'react';
import { createPortal } from 'react-dom';

import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';

type TooltipProps = {
  children: React.ReactNode;
  content?: React.ReactNode;
  position?: Side;
  /** Extra classes merged onto the bubble. */
  className?: string;
  /** Replaces (does not merge with) the hover wrapper's class list. */
  wrapperClassName?: string;
  /** Milliseconds before the bubble appears. */
  delay?: number;
};

// Distance between the anchor's edge and the bubble, in px.
const EDGE_GAP = 6;

// Parked off-screen and invisible until the first measurement lands.
const PARKED_STYLE: React.CSSProperties = {
  position: 'fixed',
  top: -9999,
  left: -9999,
  opacity: 0,
};

function bubbleStyleFor(anchor: DOMRect, side: Side): React.CSSProperties {
  const midX = anchor.left + anchor.width / 2;
  const midY = anchor.top + anchor.height / 2;
  switch (side) {
    case 'bottom':
      return { position: 'fixed', left: midX, top: anchor.bottom + EDGE_GAP, transform: 'translate(-50%, 0)' };
    case 'left':
      return { position: 'fixed', left: anchor.left - EDGE_GAP, top: midY, transform: 'translate(-100%, -50%)' };
    case 'right':
      return { position: 'fixed', left: anchor.right + EDGE_GAP, top: midY, transform: 'translate(0, -50%)' };
    case 'top':
    default:
      return { position: 'fixed', left: midX, top: anchor.top - EDGE_GAP, transform: 'translate(-50%, -100%)' };
  }
}

// The triangle sits on the bubble edge that faces the anchor.
const ARROW_CLASS: Record<Side, string> = {
  top: 'left-1/2 top-full -translate-x-1/2 border-t-foreground',
  bottom: 'left-1/2 bottom-full -translate-x-1/2 border-b-foreground',
  left: 'top-1/2 left-full -translate-y-1/2 border-l-foreground',
  right: 'top-1/2 right-full -translate-y-1/2 border-r-foreground',
};

function normaliseSide(side: string): Side {
  return side === 'bottom' || side === 'left' || side === 'right' ? side : 'top';
}

export default function Tooltip({
  children,
  content,
  position = 'top',
  className = '',
  wrapperClassName = 'relative inline-block',
  delay = 300,
}: TooltipProps) {
  const [visible, setVisible] = React.useState(false);
  const [bubbleStyle, setBubbleStyle] = React.useState<React.CSSProperties | null>(null);
  const wrapperRef = React.useRef<HTMLDivElement | null>(null);
  const timerRef = React.useRef<number | null>(null);
  const longPressRef = React.useRef(false);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const armTimer = React.useCallback((fire: () => void) => {
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      fire();
    }, delay);
  }, [delay]);

  // Never let a pending timer flip state after unmount.
  React.useEffect(() => clearTimer, [clearTimer]);

  // Any pointer-down outside the wrapper dismisses (long-press tooltips
  // otherwise stay open after the finger lifts).
  React.useEffect(() => {
    if (!visible || typeof document === 'undefined') return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapperRef.current?.contains(target)) return;
      longPressRef.current = false;
      setVisible(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [visible]);

  // Measure once the portal has rendered, then follow resizes and scrolls.
  React.useEffect(() => {
    if (!visible || typeof window === 'undefined') {
      setBubbleStyle(null);
      return;
    }
    const side = normaliseSide(position);
    const measure = () => {
      const anchor = wrapperRef.current;
      if (!anchor) return;
      setBubbleStyle(bubbleStyleFor(anchor.getBoundingClientRect(), side));
    };
    const frame = window.requestAnimationFrame(measure);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      setBubbleStyle(null);
    };
  }, [visible, position]);

  if (!content) {
    return <>{children}</>;
  }

  const handleMouseEnter = () => {
    clearTimer();
    armTimer(() => setVisible(true));
  };
  const handleMouseLeave = () => {
    clearTimer();
    setVisible(false);
  };
  const handleTouchStart = () => {
    clearTimer();
    longPressRef.current = false;
    armTimer(() => {
      longPressRef.current = true;
      setVisible(true);
    });
  };
  const handleTouchEnd = () => {
    clearTimer();
    if (longPressRef.current) return;
    setVisible(false);
  };

  const side = normaliseSide(position);
  const canPortal = visible && typeof document !== 'undefined';

  return (
    <>
      <div
        ref={wrapperRef}
        className={wrapperClassName}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={handleTouchEnd}
      >
        {children}
      </div>
      {canPortal &&
        createPortal(
          <div
            style={bubbleStyle ?? PARKED_STYLE}
            className={cn(
              'pointer-events-none z-[9999] rounded-md bg-foreground px-2 py-1 text-xs font-medium whitespace-nowrap text-background shadow-lg',
              className,
            )}
          >
            {content}
            <span
              aria-hidden
              className={cn('absolute h-0 w-0 border-4 border-transparent', ARROW_CLASS[side])}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
