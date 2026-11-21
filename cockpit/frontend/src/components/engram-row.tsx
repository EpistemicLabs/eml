import { Link } from "react-router";
import { useEngramPanel } from "@/lib/engram-panel";
import { taskStage, type Engram } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FOCUS } from "@/shared/view/ui";
import { ReviewFlag, TypeBadge } from "@/shared/view/ui/EngramType";
import { StageChip } from "@/components/task-sections";

// Ported from packages/web/components/engram-row.tsx (next/link → react-router Link).

export function preview(engram: Engram): string {
  if (engram.title) return engram.title;
  const firstLine = engram.content.split("\n").find((l) => l.trim());
  return (firstLine ?? engram.content).slice(0, 120);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m} ${y.slice(2)}`;
}

export function EngramRow({
  engram,
  showScope = false,
  hideType = false,
  siblings,
  subtasks,
}: {
  engram: Engram;
  showScope?: boolean;
  hideType?: boolean;
  siblings?: string[];
  /** v0.15: open / total sub-tasks of a parent task, when the caller knows them. */
  subtasks?: { open: number; total: number };
}) {
  const { hrefFor, setSource } = useEngramPanel();
  const dimmed = engram.status !== "active" && engram.status !== "planned";
  const stage = dimmed ? null : taskStage(engram);
  return (
    <Link
      to={hrefFor(engram.id)}
      onClick={() => setSource(siblings ?? null)}
      className={cn("flex items-start gap-3 rounded-lg bg-background px-3 py-2 transition-colors duration-(--duration-fast) hover:bg-muted", FOCUS)}
    >
      {!hideType && (
        <div className="pt-0.5">
          <TypeBadge type={engram.type} />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className={cn("flex items-center gap-2 text-body", dimmed && "text-muted-foreground")}>
          <span className="truncate">{preview(engram)}</span>
          {stage && <StageChip stage={stage} />}
          {subtasks && subtasks.total > 0 && (
            <span
              title={`${subtasks.open} of ${subtasks.total} sub-tasks open`}
              className="shrink-0 rounded-full border border-border px-1.5 text-caption text-muted-foreground tabular-nums"
            >
              {subtasks.open}/{subtasks.total}
            </span>
          )}
          {engram.review_due && <ReviewFlag />}
        </div>
        <div className="mt-0.5 truncate text-ui text-muted-foreground">
          {[
            showScope ? engram.scope : null,
            formatDate(engram.created_at),
            showScope ? null : engram.status,
            engram.ingested_by ? `by ${engram.ingested_by}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
    </Link>
  );
}
