import { useMemo } from "react";
import { useEngramPanel } from "@/lib/engram-panel";
import { TYPE_COLORS } from "@/components/ui/badge";
import { REVIEW_LABEL, type Engram } from "@/lib/types";

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
        <div key={col.key} className="flex w-[220px] shrink-0 flex-col gap-2">
          <div className="sticky top-0 flex items-baseline justify-between border-b border-border pb-1">
            <div className="text-sm font-semibold text-foreground">{col.month} {col.day}</div>
            <div className="text-xs text-muted-foreground">{col.items.length}</div>
          </div>
          <div className="flex flex-col gap-1.5 overflow-y-auto pr-1">
            {col.items.map((e) => {
              const color = TYPE_COLORS[e.type] ?? "var(--color-muted-foreground)";
              const current = isCurrent(e);
              return (
                <button
                  key={e.id}
                  onClick={() => open(e.id, orderedIds)}
                  className="rounded-md border border-border bg-card p-2 text-left transition-shadow hover:shadow-md"
                  style={{ borderLeft: `4px solid ${color}`, opacity: current ? 1 : 0.45 }}
                  title={current ? cardTitle(e) : `${cardTitle(e)} — ${e.status}`}
                >
                  <div className="flex items-center justify-between gap-1">
                    <div className="text-[9px] font-semibold uppercase tracking-wide" style={{ color }}>
                      {e.type}
                    </div>
                    <div className="flex items-center gap-1">
                      {e.labels?.includes(REVIEW_LABEL) && (
                        <span className="text-[10px] leading-none text-warning" title="Flagged for review">⚑</span>
                      )}
                      {!current && (
                        <div className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                          {e.status}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className={`line-clamp-2 text-xs text-foreground/80${current ? "" : " line-through decoration-1"}`}>
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
