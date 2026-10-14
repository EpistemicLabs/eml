import * as React from "react";
import { cn } from "@/lib/utils";
import type { EngramType } from "@/lib/types";

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium",
        className,
      )}
      {...props}
    />
  );
}

/**
 * Stable color per engram type — shared by badges, chips, timeline and graph.
 * The values live in index.css, one set per theme (--type-*). Dark is the
 * "muted" set (chosen after trying the warmer "cockpit" set and finding it
 * too weak): the familiar hues, desaturated and lifted so they sit in the
 * dark ground instead of on top of it. Light is the same hues deepened to
 * read as text. Chips and badges paint with a tint of the color, never a
 * solid fill with white text.
 */
export const TYPE_COLORS: Record<EngramType, string> = {
  status: "var(--type-status)",
  task: "var(--type-task)",
  decision: "var(--type-decision)",
  reference: "var(--type-reference)",
  note: "var(--type-note)", // v0.14: warm taupe, apart from decision amber and log grey
  rule: "var(--type-rule)",
  event: "var(--type-event)",
  profile: "var(--type-profile)",
  log: "var(--type-log)",
};

/**
 * A colour at reduced opacity, for tinted fills and borders. Takes any CSS
 * colour — the palette here is CSS variables (one value per theme), not hex.
 */
export function withAlpha(color: string, alpha: number): string {
  return `color-mix(in srgb, ${color} ${Math.round(alpha * 100)}%, transparent)`;
}

/** Inline style for a type chip/badge: tinted when on, outlined when off. */
export function typeChipStyle(color: string, on = true): React.CSSProperties {
  return on
    ? { borderColor: withAlpha(color, 0.45), backgroundColor: withAlpha(color, 0.14), color }
    : { borderColor: withAlpha(color, 0.28), color: withAlpha(color, 0.7), backgroundColor: "transparent" };
}

export const TYPE_ORDER: EngramType[] = [
  "status", "task", "note", "reference", "decision", "rule", "event", "profile", "log",
];

export function TypeBadge({ type }: { type: EngramType }) {
  const color = TYPE_COLORS[type] ?? "var(--color-muted-foreground)";
  return (
    <Badge style={typeChipStyle(color)}>
      {type}
    </Badge>
  );
}

export function ReviewFlag() {
  return (
    <span className="inline-flex shrink-0 items-center rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-warning">
      review
    </span>
  );
}
