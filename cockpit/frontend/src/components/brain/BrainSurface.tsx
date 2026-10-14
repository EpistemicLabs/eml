// One brain "surface": the header Brain tab today, each brain pane later.
// Provides the surface id to the views (so links navigate the surface they
// live in), owns the scroll container, and switches between the pages of
// the mini-app (dashboard → project → search).
import { createContext, useContext, useState, type ReactNode } from 'react';

import {
  back,
  canGoBack,
  getLoc,
  go,
  initSurface,
  replace,
  reset,
  useSurfaceLoc,
  type BrainLoc,
} from '@/lib/brain-nav';
import BrainHome from './BrainHome';
import BrainProject from './BrainProject';
import BrainSearch from './BrainSearch';

const SurfaceContext = createContext<string>('tab');

export function useBrainNav() {
  const surfaceId = useContext(SurfaceContext);
  const loc = useSurfaceLoc(surfaceId);
  return {
    surfaceId,
    loc,
    go: (next: BrainLoc) => go(surfaceId, next),
    replace: (next: BrainLoc) => replace(surfaceId, next),
    back: () => back(surfaceId),
    home: () => reset(surfaceId, { view: 'dashboard' }),
    canBack: canGoBack(surfaceId),
  };
}

type BrainSurfaceProps = {
  surfaceId: string;
  initialLoc?: BrainLoc;
  /** Remember the location across reloads (the header tab does; panes don't). */
  persist?: boolean;
};

export default function BrainSurface({ surfaceId, initialLoc, persist = false }: BrainSurfaceProps) {
  // Register before the first render so children read a real location.
  useState(() => { initSurface(surfaceId, initialLoc, persist); return null; });
  const loc = useSurfaceLoc(surfaceId);

  return (
    <SurfaceContext.Provider value={surfaceId}>
      {/* @container: the views size their grids by the surface's width, not
          the viewport, so the same view works in a half-width pane. */}
      <div className="@container h-full min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-[1440px] px-6 py-5">
          {loc.view === 'dashboard' && <BrainHome />}
          {/* key: switching parent → child resets the page's search field and status pager. */}
          {loc.view === 'project' && <BrainProject key={loc.projectId} projectId={loc.projectId} />}
          {loc.view === 'search' && <BrainSearch q={loc.q} />}
        </div>
      </div>
    </SurfaceContext.Provider>
  );
}

export function BackLink({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="self-start text-ui text-muted-foreground transition-colors hover:text-foreground"
    >
      {children}
    </button>
  );
}

// Re-exported for callers that only hold a surface id (e.g. the header tab).
export { getLoc as getSurfaceLoc };
