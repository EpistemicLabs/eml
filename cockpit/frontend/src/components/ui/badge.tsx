import * as React from "react";
import { cn } from "@/lib/utils";
import type { EngramType } from "@/lib/types";
import { Chip } from "@/shared/view/ui";

export function Badge({
  className,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-caption font-medium text-muted-foreground",
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
 * read as text. In v2 the hue is only a small dot (TypeDot) or a graph node;
 * the text and fill of a badge stay monochrome.
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
  learning: "var(--type-learning)", // v0.19: olive, apart from status green and rule red
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
  "status", "task", "note", "reference", "decision", "rule", "learning", "event", "profile", "log",
];

/** The type's hue as a small dot: the one place a type shows its colour outside the graph. */
export function TypeDot({ type, className }: { type: EngramType; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ backgroundColor: TYPE_COLORS[type] ?? "var(--color-muted-foreground)" }}
    />
  );
}

export function TypeBadge({ type }: { type: EngramType }) {
  return (
    <Badge>
      <TypeDot type={type} />
      {type}
    </Badge>
  );
}

/** Due for review: it waits on you, so it carries the amber of "needs you". */
export function ReviewFlag() {
  return (
    <Chip hue="you" className="shrink-0 uppercase tracking-label">
      review
    </Chip>
  );
}
