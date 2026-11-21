import { useMemo } from "react";
import { useEngramPanel } from "@/lib/engram-panel";
import { type Engram } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/shared/view/ui";
import { TypeDot } from "@/shared/view/ui/EngramType";

// Ported from packages/web/components/timeline/timeline.tsx. Days become columns
// (newest first); each engram is a card in its day's column.

function dayKey(e: Engram): string {
  return e.created_at.slice(0, 10);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDay(key: string): { day: string; month: string } {
  const [, m, d] = key.split("-");
  return { day: String(Number(d)), month: MONTHS[Number(m) - 1] ?? m };
}

function cardTitle(e: Engram): string {
  if (e.title) return e.title;
  const line = e.content.split("\n").find((l) => l.trim()) ?? e.content;
  return line.slice(0, 80);
}

function isCurrent(e: Engram): boolean {
  return e.status === "active" || e.status === "planned";
}

export function Timeline({ engrams }: { engrams: Engram[] }) {
  const { open } = useEngramPanel();

  const columns = useMemo(() => {
    const byDay = new Map<string, Engram[]>();
    for (const e of engrams) {
      const k = dayKey(e);
      (byDay.get(k) ?? byDay.set(k, []).get(k)!).push(e);
    }
    const days = [...byDay.keys()].sort((a, b) => (a < b ? 1 : -1));
    return days.map((k) => ({
      key: k,
      ...formatDay(k),
      items: byDay.get(k)!.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)),
    }));
  }, [engrams]);

  const orderedIds = useMemo(
    () => columns.flatMap((c) => c.items.map((e) => e.id)),
    [columns],
  );

  if (columns.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        No engrams in the selected filters.
      </div>
    );
  }

  return (
    <div className="flex h-full gap-3 overflow-x-auto p-3">
      {columns.map((col) => (
        <div key={col.key} className="flex w-(--size-graph-hub) shrink-0 flex-col gap-2">
          <div className="sticky top-0 flex items-baseline justify-between border-b border-border bg-background pb-1">
            <div className="text-body font-semibold text-foreground">{col.month} {col.day}</div>
            <div className="text-ui tabular-nums text-muted-foreground">{col.items.length}</div>
          </div>
          <div className="flex flex-col gap-1.5 overflow-y-auto pr-1">
            {col.items.map((e) => {
              const current = isCurrent(e);
              return (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => open(e.id, orderedIds)}
                  // A card no longer current reads as history (dashed, struck through), never faded.
                  className={cn(
                    "rounded-md border bg-card p-2 text-left transition-shadow duration-(--duration-fast) hover:shadow-raised",
                    current ? "border-border" : "border-dashed border-border-strong bg-transparent",
                    FOCUS,
                  )}
                  title={current ? cardTitle(e) : `${cardTitle(e)} — ${e.status}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="flex items-center gap-1 text-caption font-semibold uppercase tracking-label text-muted-foreground">
                      <TypeDot type={e.type} />
                      {e.type}
                    </div>
                    <div className="flex items-center gap-1">
                      {e.review_due && (
                        <span className="text-caption leading-none text-you-ink" title="Flagged for review">⚑</span>
                      )}
                      {!current && (
                        <div className="text-caption font-medium uppercase tracking-label text-muted-foreground">
                          {e.status}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className={cn("line-clamp-2 text-ui", current ? "text-foreground" : "text-muted-foreground line-through decoration-1")}>
                    {cardTitle(e)}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
