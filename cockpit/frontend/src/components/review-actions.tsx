import { useState } from "react";
import { useConfirmReview, useRetireEngram, useCreateReviewTask } from "@/lib/queries";
import type { Engram } from "@/lib/types";
import { parseBrainTime } from "@/components/task-sections";

// v0.15: a task is flagged for inactivity — its last movement is the later of
// updated_at and the newest journal entry.
function lastMovement(engram: Engram): { at: number; what: string } {
  const updated = parseBrainTime(engram.updated_at);
  const newest = engram.entries?.at(-1);
  const entryAt = newest ? parseBrainTime(newest.at) : -Infinity;
  return entryAt > updated ? { at: entryAt, what: "entry" } : { at: updated, what: "change" };
}

// Ported from packages/web/components/review-actions.tsx (cockpit chip
// styling). The review-triage bar — shown in the engram detail only while
// the engram carries the `review` flag. Three outcomes:
//   Still current → confirm-review with why it still holds (a review entry;
//                   renews the clock, drops the flag) — v0.19
//   Retire        → status = expired (drops the flag, moves to history)
//   New task      → follow-up task linked back; the flag stays — confirm or
//                   retire once the task is done
// v0.15 for a task (flagged after 30 days without movement): "Still relevant"
// counts as a movement; Retire invalidates it with outcome "retired in review"
// (open sub-tasks and bound decisions/notes close with it — keep: [], the
// core cascade).
export function ReviewActions({ engram }: { engram: Engram }) {
  const isTask = engram.type === "task";
  const confirm = useConfirmReview();
  const retire = useRetireEngram();
  const createTask = useCreateReviewTask();

  const [taskOpen, setTaskOpen] = useState(false);
  const [taskText, setTaskText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [why, setWhy] = useState("");

  function submitConfirm() {
    const text = why.trim();
    if (!text) return;
    confirm.mutate({ id: engram.id, text }, { onSuccess: () => { setWhy(""); setConfirmOpen(false); } });
  }

  const busy = confirm.isPending || retire.isPending || createTask.isPending;
  const error =
    (confirm.error as Error | null)?.message ??
    (retire.error as Error | null)?.message ??
    (createTask.error as Error | null)?.message ??
    null;

  function submitTask() {
    const content = taskText.trim();
    if (!content) return;
    createTask.mutate(
      { engram, content },
      {
        onSuccess: () => {
          setTaskText("");
          setTaskOpen(false);
        },
      },
    );
  }

  const action =
    "h-7 rounded-md border border-border bg-foreground/[0.04] px-2.5 text-ui font-medium text-foreground transition-colors hover:bg-foreground/[0.08] disabled:opacity-40";

  return (
    <div className="rounded-lg border border-warning/30 bg-warning/[0.06] p-3">
      <div className="mb-2 flex items-center gap-1.5 text-caption font-semibold tracking-wide text-warning uppercase">
        <span aria-hidden>⚑</span> Flagged for review
      </div>
      {isTask && (() => {
        const last = lastMovement(engram);
        const days = Math.floor((Date.now() - last.at) / 86_400_000);
        return (
          <p className="-mt-1 mb-2 text-caption text-muted-foreground">
            No movement for {days} days (last: {last.what} on {new Date(last.at).toISOString().slice(0, 10)}).
          </p>
        );
      })()}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => (isTask ? confirm.mutate({ id: engram.id }) : setConfirmOpen((v) => !v))}
          disabled={busy}
          title={
            isTask
              ? "Still relevant — counts as movement; flagged again after 30 days without movement"
              : "Still current — say why; it is kept as a review entry and the review clock restarts (decision 60d · rule 90d · profile 180d)"
          }
          className={
            confirmOpen
              ? "h-7 rounded-md border border-primary bg-primary px-2.5 text-ui font-medium text-primary-foreground disabled:opacity-40"
              : action
          }
        >
          {isTask ? "✓ Still relevant" : "✓ Still current"}
        </button>
        <button
          type="button"
          onClick={() => retire.mutate(engram)}
          disabled={busy}
          title={
            isTask
              ? "Drop it — invalidated with outcome “retired in review”; open sub-tasks and bound decisions and notes close with it"
              : "Outdated — marks the engram expired and drops the flag"
          }
          className={action}
        >
          ⌛ Retire
        </button>
        <button
          type="button"
          onClick={() => setTaskOpen((v) => !v)}
          disabled={busy}
          title="Needs work — spin up a follow-up task linked to this engram"
          className={
            taskOpen
              ? "h-7 rounded-md border border-primary bg-primary px-2.5 text-ui font-medium text-primary-foreground disabled:opacity-40"
              : action
          }
        >
          + New task
        </button>
      </div>

      {confirmOpen && !isTask && (
        <div className="mt-3 flex gap-2">
          <input
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitConfirm(); }}
            placeholder="Why it still holds"
            autoFocus
            className="h-7 min-w-0 flex-1 rounded-md border border-foreground/15 bg-foreground/[0.04] px-2.5 text-body text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
          />
          <button
            type="button"
            onClick={submitConfirm}
            disabled={!why.trim() || confirm.isPending}
            className="h-7 rounded-md border border-primary bg-primary px-2.5 text-ui font-medium text-primary-foreground transition-opacity disabled:opacity-40"
          >
            {confirm.isPending ? "Confirming…" : "Confirm"}
          </button>
        </div>
      )}

      {taskOpen && (
        <div className="mt-3 flex flex-col gap-2">
          <textarea
            value={taskText}
            onChange={(e) => setTaskText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitTask();
            }}
            placeholder="What needs to be done? (⌘/Ctrl+Enter to create)"
            rows={3}
            className="w-full resize-y rounded-md border border-foreground/15 bg-foreground/[0.04] px-2.5 py-1.5 text-body text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={submitTask}
              disabled={!taskText.trim() || createTask.isPending}
              className="h-7 rounded-md border border-primary bg-primary px-2.5 text-ui font-medium text-primary-foreground transition-opacity disabled:opacity-40"
            >
              {createTask.isPending ? "Creating…" : "Create task"}
            </button>
            <button
              type="button"
              onClick={() => {
                setTaskOpen(false);
                setTaskText("");
              }}
              className={action}
            >
              Cancel
            </button>
          </div>
          <p className="text-caption text-muted-foreground">The flag stays; confirm or retire once the task is done.</p>
        </div>
      )}

      {error && <p className="mt-2 text-caption text-destructive">{error}</p>}
    </div>
  );
}
