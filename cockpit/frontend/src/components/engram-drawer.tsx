import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEngramPanel } from "@/lib/engram-panel";
import { EngramDetail } from "@/components/engram-detail";
import type { Project } from "@/types/app";

// Ported from packages/web/components/engram-drawer.tsx. Global right-side
// drawer, mounted once in AppContent. Driven entirely by the `?engram=<id>`
// query param (see useEngramPanel) so it works over any surface — the Brain
// tab's pages and, later, brain panes — without prop drilling. Overlay
// without dimming, ~600px, as a card like the pinned sidebar: below the
// header, 8px off the edges, rounded, the sidebar's popover background. Closes on ✕, click outside, or Esc; a click on
// another engram link behind it opens that engram in place (0.15.1). When opened from a list,
// prev/next (‹ ›, j/k, arrows) page through that list. Cockpit seam: the
// panel takes focus on open so keystrokes land here, not in a terminal
// behind the backdrop.
export function EngramDrawer({ projects }: { projects: Project[] }) {
  const { openedId, hrefFor, go, close, back, source } = useEngramPanel();

  // Reconstruct the visited trail from `?engram` changes so we know whether
  // there's a hop to go back to (drives the ← button). Derived from the URL —
  // not a parallel history — so it stays in sync with the browser back/forward
  // buttons too. Going back lands on trail[-2] → pop; a new id → push.
  const trailRef = useRef<string[]>([]);
  const [canGoBack, setCanGoBack] = useState(false);
  useEffect(() => {
    const t = trailRef.current;
    if (!openedId) {
      trailRef.current = [];
      setCanGoBack(false);
      return;
    }
    if (t.length >= 2 && t[t.length - 2] === openedId) {
      t.pop();
    } else if (t[t.length - 1] !== openedId) {
      t.push(openedId);
    }
    setCanGoBack(t.length > 1);
  }, [openedId]);

  // Paging position within the source list (the list clicked from). No source,
  // or an id not in it → no pager.
  const { prevId, nextId, index, total } = useMemo(() => {
    if (!source || !openedId) return { prevId: null, nextId: null, index: -1, total: 0 };
    const i = source.indexOf(openedId);
    if (i < 0) return { prevId: null, nextId: null, index: -1, total: 0 };
    return {
      prevId: i > 0 ? source[i - 1] : null,
      nextId: i < source.length - 1 ? source[i + 1] : null,
      index: i,
      total: source.length,
    };
  }, [source, openedId]);

  const goPrev = useCallback(() => prevId && go(prevId), [prevId, go]);
  const goNext = useCallback(() => nextId && go(nextId), [nextId, go]);

  // Slide in on open, slide out on close. `entered` drives the transform;
  // `renderId` keeps the panel mounted (with its last content) through the exit
  // animation, then unmounts. Paging (id → id, both truthy) never triggers exit.
  const SLIDE_MS = 200;
  const [entered, setEntered] = useState(false);
  const [renderId, setRenderId] = useState<string | null>(openedId);
  const asideRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (openedId) {
      setRenderId(openedId);
      const raf = requestAnimationFrame(() => {
        setEntered(true);
        asideRef.current?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    setEntered(false); // start slide-out
    const t = setTimeout(() => setRenderId(null), SLIDE_MS);
    return () => clearTimeout(t);
  }, [openedId]);

  useEffect(() => {
    if (!openedId) return;
    const onKey = (e: KeyboardEvent) => {
      // Typing in the drawer (the new-task textarea) must keep its keys.
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT");
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
      } else if (typing) {
        return;
      } else if (e.key === "ArrowDown" || e.key === "j") goNext();
      else if (e.key === "ArrowUp" || e.key === "k") goPrev();
      else if (e.key === "ArrowLeft" || e.key === "Backspace") {
        if (canGoBack) {
          e.preventDefault();
          back();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openedId, close, goPrev, goNext, back, canGoBack]);

  // Click outside: the page behind stays clickable (no click-catcher), so an
  // engram link there just swaps the drawer's content; anything else closes.
  useEffect(() => {
    if (!openedId) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || asideRef.current?.contains(target)) return;
      if (target.closest('a[href*="engram="]')) return;
      close();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [openedId, close]);

  if (!renderId) return null;

  const hasPager = total > 1 && index >= 0;
  const pagerButton =
    "flex h-6 w-6 items-center justify-center rounded-md border border-border text-caption text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:opacity-30 disabled:hover:text-muted-foreground";

  return (
    // The page behind stays as it is — no dimming, no blur — and
    // stays clickable: only the drawer takes pointer events.
    <div className="pointer-events-none fixed inset-0 z-50">
      <aside
        ref={asideRef}
        tabIndex={-1}
        className={`absolute top-[3.25rem] right-2 bottom-2 flex w-[calc(100%-1rem)] flex-col overflow-hidden rounded-lg border border-border bg-popover shadow-2xl outline-none transition-transform duration-200 sm:w-[min(600px,70vw)] ${entered ? "pointer-events-auto translate-x-0" : "translate-x-[calc(100%+1rem)]"}`}
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            {canGoBack && (
              <button
                type="button"
                onClick={back}
                aria-label="Back"
                title="Back (←)"
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-ui text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                ← Back
              </button>
            )}
            {hasPager ? (
              <div className="flex items-center gap-1 text-caption text-muted-foreground">
                <button type="button" onClick={goPrev} disabled={!prevId} aria-label="Previous" title="Previous (k / ↑)" className={pagerButton}>
                  ‹
                </button>
                <span className="tabular-nums">{index + 1}/{total}</span>
                <button type="button" onClick={goNext} disabled={!nextId} aria-label="Next" title="Next (j / ↓)" className={pagerButton}>
                  ›
                </button>
              </div>
            ) : (
              !canGoBack && (
                <span className="text-xs font-semibold tracking-wider text-muted-foreground uppercase">Engram</span>
              )
            )}
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            title="Close (Esc)"
            className="rounded-md px-2 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-5">
          <EngramDetail id={renderId} relationHref={hrefFor} projects={projects} onLeave={close} />
        </div>
      </aside>
    </div>
  );
}
