// Ported from packages/web/components/home/activity-heatmap.tsx: the same
// data-driven contribution grid (max 30 weeks, back to the first active day,
// click a day to filter the activity list). Adapted to the cockpit look:
// the intensity scale is coral (the brand accent) over the muted surface
// instead of GitHub green; selection outlines in the foreground colour.
// The grid is wider than its card, so it opens scrolled to today (right end)
// and stays pinned there on resize unless the user scrolled back in time.
import { useLayoutEffect, useMemo, useRef } from "react";

import { useActivityByDay } from "@/lib/queries";
import { SectionHeader } from "./ui";

const MAX_WEEKS = 30;
const CELL = 13;
const GAP = 3;

// Empty → muted surface; then four coral steps.
const SCALE = [
  "var(--color-muted)",
  "color-mix(in srgb, var(--color-primary) 28%, var(--color-muted))",
  "color-mix(in srgb, var(--color-primary) 50%, var(--color-muted))",
  "color-mix(in srgb, var(--color-primary) 75%, var(--color-muted))",
  "var(--color-primary)",
];
function shade(count: number): string {
  if (count <= 0) return SCALE[0];
  if (count <= 2) return SCALE[1];
  if (count <= 5) return SCALE[2];
  if (count <= 9) return SCALE[3];
  return SCALE[4];
}

const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
const WEEKDAYS = ["", "Mon", "", "Wed", "", "Fri", ""];

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function ActivityHeatmap({
  selectedDay = null,
  onSelectDay,
}: {
  selectedDay?: string | null;
  onSelectDay?: (day: string | null) => void;
}) {
  const { data, isLoading } = useActivityByDay();
  const counts = data?.counts ?? {};

  const { columns, monthLabels, total, weeks } = useMemo(() => {
    const now = new Date();
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    // Data-driven range: from the first active day (floored to its week), but
    // never more than MAX_WEEKS back — no empty leading months.
    const days = Object.keys(counts);
    let earliest = today;
    for (const d of days) {
      const dt = new Date(`${d}T00:00:00Z`);
      if (dt < earliest) earliest = dt;
    }
    const cap = new Date(today.getTime() - (MAX_WEEKS - 1) * 7 * 86_400_000);
    const start = new Date(earliest < cap ? cap : earliest);
    start.setUTCDate(start.getUTCDate() - start.getUTCDay()); // back to Sunday
    const weeks = Math.ceil((today.getTime() - start.getTime()) / (7 * 86_400_000)) + 1;

    const columns: { date: Date; count: number; future: boolean }[][] = [];
    const monthLabels: { col: number; label: string }[] = [];
    let total = 0;
    let lastMonth = -1;
    for (let w = 0; w < weeks; w++) {
      const col: { date: Date; count: number; future: boolean }[] = [];
      for (let d = 0; d < 7; d++) {
        const date = new Date(start);
        date.setUTCDate(start.getUTCDate() + w * 7 + d);
        const future = date > today;
        const count = future ? 0 : (counts[dayKey(date)] ?? 0);
        total += count;
        col.push({ date, count, future });
        if (d === 0 && date.getUTCMonth() !== lastMonth && !future) {
          lastMonth = date.getUTCMonth();
          monthLabels.push({ col: w, label: MONTHS[lastMonth] });
        }
      }
      columns.push(col);
    }
    return { columns, monthLabels, total, weeks };
  }, [counts]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToEnd = useRef(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const pin = () => {
      if (pinnedToEnd.current) el.scrollLeft = el.scrollWidth;
    };
    pin();
    // The card width follows a container query; re-pin when it changes.
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    return () => observer.disconnect();
  }, [weeks]);

  return (
    <div>
      <SectionHeader
        title="Activity"
        right={
          <span className="text-caption tabular-nums text-muted-foreground">
            {isLoading ? "…" : `${total} in ${weeks} weeks`}
          </span>
        }
      />
      <div
        ref={scrollRef}
        className="overflow-x-auto"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedToEnd.current = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
        }}
      >
        <div className="inline-flex gap-1.5">
          {/* weekday labels */}
          <div className="flex flex-col pt-4" style={{ gap: GAP }}>
            {WEEKDAYS.map((w, i) => (
              <span
                key={i}
                className="text-[9px] leading-none text-muted-foreground"
                style={{ height: CELL, lineHeight: `${CELL}px` }}
              >
                {w}
              </span>
            ))}
          </div>
          <div className="inline-flex flex-col gap-1">
            {/* month labels */}
            <div className="relative h-3" style={{ width: weeks * (CELL + GAP) }}>
              {monthLabels.map((m) => (
                <span
                  key={`${m.col}-${m.label}`}
                  className="absolute text-[10px] text-muted-foreground"
                  style={{ left: m.col * (CELL + GAP) }}
                >
                  {m.label}
                </span>
              ))}
            </div>
            <div className="flex" style={{ gap: GAP }}>
              {columns.map((col, w) => (
                <div key={w} className="flex flex-col" style={{ gap: GAP }}>
                  {col.map((cell, d) => {
                    const key = dayKey(cell.date);
                    const clickable = !cell.future && cell.count > 0;
                    const selected = selectedDay === key;
                    return (
                      <div
                        key={d}
                        onClick={
                          clickable && onSelectDay
                            ? () => onSelectDay(selected ? null : key)
                            : undefined
                        }
                        title={
                          cell.future
                            ? ""
                            : `${key}: ${cell.count} engram${cell.count === 1 ? "" : "s"}`
                        }
                        style={{
                          width: CELL,
                          height: CELL,
                          borderRadius: 3,
                          background: cell.future ? "transparent" : shade(cell.count),
                          cursor: clickable ? "pointer" : "default",
                          outline: selected ? "2px solid var(--color-foreground)" : "none",
                          outlineOffset: selected ? 1 : 0,
                        }}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        <span>less</span>
        {SCALE.map((c) => (
          <span key={c} style={{ width: CELL, height: CELL, borderRadius: 3, background: c }} />
        ))}
        <span>more</span>
      </div>
    </div>
  );
}
