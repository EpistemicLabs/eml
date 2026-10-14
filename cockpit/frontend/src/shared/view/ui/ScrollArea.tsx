import * as React from 'react';

import { cn } from '@/lib/utils';

// Momentum scrolling on iOS plus vertical-only panning on touch.
const SCROLLER_STYLE: React.CSSProperties = {
  WebkitOverflowScrolling: 'touch',
  touchAction: 'pan-y',
};

/**
 * Outer frame (layout classes, pointer handlers, clips to rounded corners)
 * around an inner element that does the scrolling and carries the ref, so
 * callers can read the real `scrollTop`.
 */
export const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, children, ...rest }, ref) {
    return (
      // Own classes last on purpose: a caller's overflow utility must not
      // make the frame itself scroll.
      <div className={cn(className, 'relative overflow-hidden')} {...rest}>
        <div ref={ref} className="h-full w-full overflow-auto rounded-[inherit]" style={SCROLLER_STYLE}>
          {children}
        </div>
      </div>
    );
  },
);
ScrollArea.displayName = 'ScrollArea';
