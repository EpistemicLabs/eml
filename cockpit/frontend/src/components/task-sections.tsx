import { useState } from "react";
import { Link } from "react-router";
import { useQueries } from "@tanstack/react-query";
import { engramQuery, useAddTaskEntry } from "@/lib/queries";
import { TypeBadge, TYPE_COLORS, withAlpha } from "@/components/ui/badge";
import { BrainCard } from "@/components/brain/ui";
import { TASK_STAGES, TASK_STAGE_HINTS, taskStage, type Engram, type Relation, type TaskEntry, type TaskStage } from "@/lib/types";

// v0.15 (spec §2–§4, cockpit Cluster K): the task as a hub inside the engram
// drawer — stage + status, outcome on close, parent / sub-tasks, the decisions
// and notes linked to it, and its journal. Relations shown here are taken out
// of the generic Relations card (the caller renders the rest).

const TASK = TYPE_COLORS.task;
const CLOSED_OK = TYPE_COLORS.status;
const GREY = "var(--color-muted-foreground)";
const OPEN = new Set(["planned", "active"]);

function label(e: Engram): string {
  if (e.title) return e.title;
  const line = e.content.split("\n").find((l) => l.trim());
  return (line ?? e.content).slice(0, 80);
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>;
}

export function StageChip({ stage, move = false }: { stage: TaskStage; move?: boolean }) {
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border px-1.5 text-[10px] leading-4"
      style={{ color: TASK, borderColor: withAlpha(TASK, 0.45), backgroundColor: withAlpha(TASK, 0.1) }}
    >
      {move ? `→ ${stage}` : stage}
    </span>
  );
}

/** Stage stepper (the status is in the drawer's header). Grey once the task is closed (the stage is frozen). */
export function TaskStageCard({ engram }: { engram: Engram }) {
  const stage = taskStage(engram);
  const closed = !OPEN.has(engram.status);
  if (!stage) {
    return (
      <BrainCard className="px-4 py-2.5">
        <span className="text-ui text-muted-foreground">No stage — a plain task</span>
      </BrainCard>
    );
  }
  const at = TASK_STAGES.indexOf(stage);
  const on = closed ? GREY : TASK;
  return (
    <BrainCard className="px-4 py-3">
      <CardTitle>{closed ? "Stage · frozen" : "Stage"}</CardTitle>
      <div className="flex flex-wrap gap-1" aria-label={`Stage: ${stage}`}>
        {TASK_STAGES.map((s, i) => (
          <div key={s} className="flex min-w-16 flex-1 flex-col gap-1">
            <div
              className="h-1 rounded-full"
              style={{ background: i < at ? withAlpha(on, 0.5) : i === at ? on : "var(--color-muted)" }}
            />
            <span title={TASK_STAGE_HINTS[s]} className={`text-caption ${i === at ? "font-semibold text-foreground" : "text-muted-foreground"}`}>{s}</span>
          </div>
        ))}
      </div>
    </BrainCard>
  );
}

/** The closing result — shown once a task is resolved or invalidated. */
export function TaskOutcome({ engram }: { engram: Engram }) {
  const outcome = engram.properties?.outcome;
  if (typeof outcome !== "string" || !outcome.trim()) return null;
  const color = engram.status === "resolved" ? CLOSED_OK : GREY;
  return (
    <div
      className="flex items-baseline gap-3 rounded-lg border px-3.5 py-2.5"
      style={{ borderColor: withAlpha(color, 0.4), backgroundColor: withAlpha(color, 0.08) }}
    >
      <span className="text-caption font-semibold tracking-wider uppercase" style={{ color }}>Outcome</span>
      <span className="text-ui text-foreground">{outcome}</span>
    </div>
  );
}

function HubRow({ e, relation, href, side }: { e: Engram; relation?: string; href: string; side?: React.ReactNode }) {
  const stage = taskStage(e);
  return (
    <Link to={href} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted">
      {relation && (
        <>
          <span className="w-3 shrink-0 text-center text-muted-foreground">←</span>
          <span className="shrink-0 text-caption text-muted-foreground">{relation}</span>
        </>
      )}
      <span className="shrink-0">
        <TypeBadge type={e.type} />
      </span>
      <span className="min-w-0 flex-1 truncate text-ui">{label(e)}</span>
      {stage && OPEN.has(e.status) && <StageChip stage={stage} />}
      {side}
    </Link>
  );
}

function MiniStatus({ status }: { status: string }) {
  const color = status === "active" ? TASK : status === "resolved" ? CLOSED_OK : undefined;
  return (
    <span
      className="shrink-0 rounded-full border border-border px-1.5 text-[10px] leading-4 text-muted-foreground"
      style={color ? { color, borderColor: withAlpha(color, 0.45) } : undefined}
    >
      {status}
    </span>
  );
}

/**
 * Hub blocks for a task + the relations left for the generic card. Loads the
 * linked engrams in one batch (react-query cached — opening one is instant).
 */
export function useTaskHub(engram: Engram) {
  // Non-task engrams have no hub — no extra loads (the hook still runs, unconditionally).
  const rels = engram.type === "task" ? (engram.relations ?? []) : [];
  const parentRel = rels.find((r) => r.relation === "part_of" && r.source_id === engram.id);
  const childRels = rels.filter((r) => r.relation === "part_of" && r.target_id === engram.id);
  const linkRels = rels.filter(
    (r) => r.target_id === engram.id && (r.relation === "derived_from" || r.relation === "refines"),
  );
  const ids = [...childRels.map((r) => r.source_id), ...linkRels.map((r) => r.source_id)];
  const results = useQueries({ queries: ids.map((id) => engramQuery(id)) });
  const byId = new Map<string, Engram>();
  results.forEach((q) => q.data && byId.set(q.data.id, q.data));

  const children = childRels.map((r) => byId.get(r.source_id)).filter((e): e is Engram => !!e);
  const decisions: Array<{ r: Relation; e: Engram }> = [];
  const notes: Array<{ r: Relation; e: Engram }> = [];
  for (const r of linkRels) {
    const e = byId.get(r.source_id);
    if (!e) continue;
    if (r.relation === "derived_from" && e.type === "decision") decisions.push({ r, e });
    else if (r.relation === "refines" && e.type !== "task") notes.push({ r, e });
  }
  const shown = new Set<string>([
    ...(parentRel ? [parentRel.id] : []),
    ...childRels.map((r) => r.id),
    ...decisions.map((x) => x.r.id),
    ...notes.map((x) => x.r.id),
  ]);
  return {
    parentId: parentRel?.target_id ?? null,
    children,
    decisions,
    notes,
    rest: (engram.relations ?? []).filter((r) => !shown.has(r.id)),
  };
}

export function TaskHubBlocks({
  hub,
  relationHref,
  ParentRef,
}: {
  hub: ReturnType<typeof useTaskHub>;
  relationHref: (otherId: string) => string;
  ParentRef: (props: { id: string }) => React.ReactNode;
}) {
  const open = hub.children.filter((c) => OPEN.has(c.status)).length;
  return (
    <>
      {(hub.parentId || hub.children.length > 0) && (
        <BrainCard className="px-3 py-3">
          {hub.parentId && (
            <div className="mb-2 flex items-center gap-2 px-1 text-ui text-muted-foreground">
              <span>Part of</span>
              <ParentRef id={hub.parentId} />
            </div>
          )}
          {hub.children.length > 0 && (
            <>
              <div className="px-1">
                <CardTitle>
                  Sub-tasks <span className="font-normal tracking-normal normal-case">· {open} of {hub.children.length} open</span>
                </CardTitle>
              </div>
              <div className="flex flex-col gap-0.5">
                {hub.children.map((c) => (
                  <HubRow key={c.id} e={c} href={relationHref(c.id)} side={<MiniStatus status={c.status} />} />
                ))}
              </div>
            </>
          )}
        </BrainCard>
      )}
      {(hub.decisions.length > 0 || hub.notes.length > 0) && (
        <BrainCard className="px-3 py-3">
          {hub.decisions.length > 0 && (
            <>
              <div className="px-1">
                <CardTitle>Decisions <span className="font-normal tracking-normal normal-case">· {hub.decisions.length}</span></CardTitle>
              </div>
              <div className="flex flex-col gap-0.5">
                {hub.decisions.map(({ r, e }) => (
                  <HubRow key={r.id} e={e} relation={r.relation} href={relationHref(e.id)} />
                ))}
              </div>
            </>
          )}
          {hub.notes.length > 0 && (
            <div className={hub.decisions.length > 0 ? "mt-3" : undefined}>
              <div className="px-1">
                <CardTitle>Plan &amp; notes <span className="font-normal tracking-normal normal-case">· {hub.notes.length}</span></CardTitle>
              </div>
              <div className="flex flex-col gap-0.5">
                {hub.notes.map(({ r, e }) => (
                  <HubRow key={r.id} e={e} relation={r.relation} href={relationHref(e.id)} />
                ))}
              </div>
            </div>
          )}
        </BrainCard>
      )}
    </>
  );
}

// "decision taken: <label> (<uuid>)" / "note written: …" — entries core writes
// for a task-linked write (Cluster C). Shown as "auto" with the id as a link.
// v0.19: the server writes change entries (kind "change"); many end with the
// id of the engram they concern — "decision taken: <label> (<id>)" — which is
// linked. Only used for the link, not to tell change from note.
const TRAILING_ID = /^(.*) \(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/s;

function formatAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The task's append-only journal, newest first, under a one-line composer. */
export function TaskJournal({ engram, relationHref }: { engram: Engram; relationHref: (otherId: string) => string }) {
  // newest first: where the task stands is the latest entry
  const entries: TaskEntry[] = (engram.entries ?? []).filter((e) => e.kind === "note" || e.kind === "change").reverse();
  const add = useAddTaskEntry();
  const [text, setText] = useState("");
  const [stage, setStage] = useState<TaskStage | "">("");
  const closed = !OPEN.has(engram.status);

  function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const t = text.trim();
    if (!t) return;
    add.mutate(
      { taskId: engram.id, text: t, stage: stage || undefined },
      { onSuccess: () => { setText(""); setStage(""); } },
    );
  }

  return (
    <BrainCard className="px-4 py-3">
      <CardTitle>
        Journal{" "}
        <span className="font-normal tracking-normal normal-case">
          · {entries.length} {entries.length === 1 ? "entry" : "entries"}, newest first
        </span>
      </CardTitle>
      <form onSubmit={submit} className="mb-3 flex flex-wrap gap-2">
        <input
          aria-label="New journal entry"
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          placeholder="Add an entry — what happened, what's next"
          className="h-7 min-w-0 flex-1 rounded-md border border-foreground/15 bg-foreground/[0.04] px-2.5 text-ui text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
        />
        {!closed && (
          <select
            aria-label="Stage change"
            value={stage}
            onChange={(ev) => setStage(ev.target.value as TaskStage | "")}
            className="h-7 rounded-md border border-foreground/15 bg-foreground/[0.04] px-1.5 text-ui text-muted-foreground outline-none focus:border-foreground/30"
          >
            <option value="">stage —</option>
            {TASK_STAGES.map((s) => <option key={s} value={s} title={TASK_STAGE_HINTS[s]}>{s}</option>)}
          </select>
        )}
        <button
          type="submit"
          disabled={!text.trim() || add.isPending}
          className="h-7 rounded-md border border-primary bg-primary px-2.5 text-ui font-medium text-primary-foreground transition-opacity disabled:opacity-40"
        >
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </form>
      {add.error && <p className="-mt-1 mb-3 text-caption text-destructive">{(add.error as Error).message}</p>}
      {entries.length === 0 ? (
        <p className="text-caption text-muted-foreground">No entries yet.</p>
      ) : (
        <ol className="flex flex-col">
          {entries.map((e, i) => {
            // A stage change is only visible against the entry before it in time
            // (the next one down) — the oldest entry just carries the stage the task had then.
            const moved = i < entries.length - 1 && e.stage !== null && e.stage !== entries[i + 1].stage;
            const change = e.kind === "change";
            const linked = change ? TRAILING_ID.exec(e.text) : null;
            return (
              <li key={e.id} className="grid grid-cols-[14px_1fr] gap-2.5">
                <div className="flex flex-col items-center">
                  <span
                    className="mt-1.5 h-[7px] w-[7px] shrink-0 rounded-full"
                    style={change ? { border: `1px solid ${TASK}`, opacity: 0.6 } : { background: TASK }}
                  />
                  {i < entries.length - 1 && <span className="mt-1 w-px flex-1 bg-border" />}
                </div>
                <div className="pb-3">
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-caption text-muted-foreground">
                    <span>{formatAt(e.at)}</span>
                    {e.author && <span>{e.author}</span>}
                    {moved && <StageChip stage={e.stage!} move />}
                    {change && <span className="rounded-full border border-dashed border-border px-1.5 text-[10px] leading-4">change</span>}
                  </div>
                  <div className={change ? "mt-0.5 text-caption whitespace-pre-wrap text-muted-foreground" : "mt-0.5 text-ui whitespace-pre-wrap text-foreground"}>
                    {linked ? (
                      <>
                        {linked[1]}{" "}
                        <Link to={relationHref(linked[2])} className="underline decoration-dotted underline-offset-2 hover:text-foreground">
                          open
                        </Link>
                      </>
                    ) : (
                      e.text
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </BrainCard>
  );
}

// v0.15: open-task lists filter by stage ("all" includes tasks without one).
export type StageFilter = "all" | TaskStage;
export const STAGE_FILTER_OPTIONS: ReadonlyArray<{ value: StageFilter; label: string }> = [
  { value: "all", label: "all" },
  ...TASK_STAGES.map((s) => ({ value: s, label: s })),
];
export function filterByStage(tasks: Engram[], f: StageFilter): Engram[] {
  return f === "all" ? tasks : tasks.filter((t) => taskStage(t) === f);
}

// Brain timestamps come as ISO ('…T…Z') or SQLite UTC ('YYYY-MM-DD HH:MM:SS').
export function parseBrainTime(t: string): number {
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(t) ? t : `${t.replace(" ", "T")}Z`);
}

/** "just now" · "5h ago" · "3d ago" · "4mo ago". */
export function timeAgo(t: string, now = Date.now()): string {
  const ms = now - parseBrainTime(t);
  if (!Number.isFinite(ms)) return t.slice(0, 10);
  const h = Math.floor(ms / 3_600_000);
  if (h < 1) return "just now";
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 60) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** Open tasks, most recently updated first (no priority sort until priority-significance-rework). */
export function byLastUpdate(tasks: Engram[]): Engram[] {
  return [...tasks].sort((a, b) => parseBrainTime(b.updated_at) - parseBrainTime(a.updated_at));
}

/**
 * v0.15: the task row for the wide open-tasks panels — kept lean: name, stage,
 * status (in progress / open), assignee, last update; the project on the
 * dashboard. Everything else lives in the engram drawer.
 */
export function TaskRow({
  task,
  href,
  onOpen,
  showScope = false,
}: {
  task: Engram;
  href: string;
  onOpen?: () => void;
  showScope?: boolean;
}) {
  const stage = taskStage(task);
  const assignee = typeof task.properties?.assignee_id === "string" ? task.properties.assignee_id : null;
  const inProgress = task.status === "active";
  return (
    <Link
      to={href}
      onClick={onOpen}
      title={task.content}
      className="flex items-center gap-4 rounded-lg bg-muted/50 px-3 py-2 transition-colors hover:bg-muted"
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className="truncate">{label(task)}</span>
          {stage && <StageChip stage={stage} />}
          {task.review_due && (
            <span className="inline-flex shrink-0 items-center rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-[10px] font-medium tracking-wide text-warning uppercase">
              review
            </span>
          )}
        </div>
        <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          {showScope && <span className="truncate">{task.scope.replace(/^project\./, "")}</span>}
          {showScope && <span aria-hidden>·</span>}
          <span className="inline-flex shrink-0 items-center gap-1.5">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={inProgress ? { background: TASK } : { boxShadow: `inset 0 0 0 1px ${GREY}` }}
            />
            {inProgress ? "in progress" : "open"}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
        {assignee && <span title="assignee">→ {assignee}</span>}
        <span title={`last update ${task.updated_at}`}>{timeAgo(task.updated_at)}</span>
      </div>
    </Link>
  );
}
