import { useState } from "react";
import { Link } from "react-router-dom";
import { useEngram, useSubjectMembers, useSubjects } from "@/lib/queries";
import { TypeBadge, ReviewFlag } from "@/components/ui/badge";
import { ReviewActions } from "@/components/review-actions";
import { BrainCard } from "@/components/brain/ui";
import { SUBJECT_STATUS_COLOR } from "@/lib/subject-graph";
import { withAlpha } from "@/components/ui/badge";
import { REVIEW_LABEL, type Engram, type Relation, type Subject } from "@/lib/types";
import { TaskHubBlocks, TaskJournal, TaskOutcome, TaskStageCard, useTaskHub } from "@/components/task-sections";
import { TaskRunCard } from "@/components/task-run";
import type { Project } from "@/types/app";

// Ported from packages/web/components/engram-detail.tsx (next/link → react-router
// Link; web's Card → the cockpit's BrainCard). The engram body inside the
// drawer: header with type + title + review flag, meta line, the review
// triage bar while flagged, subjects (v0.14) + tags, content, properties (UUIDs
// resolve to engram links) and relations (the other side resolved to type + title).

// Human label for a related engram — title if it has one, else the first
// non-empty content line, trimmed.
function engramLabel(e: Engram): string {
  if (e.title) return e.title;
  const line = e.content.split("\n").find((l) => l.trim());
  return (line ?? e.content).slice(0, 80);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

// A clickable reference to another engram by id — resolves its type + title
// so a raw UUID (in a relation or a property like `supersedes`) reads as a
// human label. Fetch is react-query-cached; falls back to a short id if the
// target can't be loaded (e.g. deleted).
function EngramRef({ id, relationHref }: { id: string; relationHref: (otherId: string) => string }) {
  const { data } = useEngram(id);
  return (
    <Link to={relationHref(id)} className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-muted">
      {data && (
        <span className="shrink-0">
          <TypeBadge type={data.type} />
        </span>
      )}
      <span className="min-w-0 truncate">{data ? engramLabel(data) : `${id.slice(0, 8)}…`}</span>
    </Link>
  );
}

// Renders one property value. UUIDs (single or a homogeneous array of them) are
// engram references → resolve to title links; everything else stays raw text.
function PropertyValue({ value, relationHref }: { value: unknown; relationHref: (otherId: string) => string }) {
  if (isUuid(value)) return <EngramRef id={value} relationHref={relationHref} />;
  if (Array.isArray(value) && value.length > 0 && value.every(isUuid)) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5">
        {value.map((id) => (
          <EngramRef key={id} id={id} relationHref={relationHref} />
        ))}
      </div>
    );
  }
  return <span className="break-all">{typeof value === "string" ? value : JSON.stringify(value)}</span>;
}

// A relation row resolves the *other* engram (relations carry only UUIDs) so it
// can show that engram's type + title instead of a raw id. The fetch is
// react-query-cached, so clicking through opens the target drawer instantly.
function RelationItem({
  relation,
  engramId,
  relationHref,
}: {
  relation: Relation;
  engramId: string;
  relationHref: (otherId: string) => string;
}) {
  const outgoing = relation.source_id === engramId;
  const other = outgoing ? relation.target_id : relation.source_id;
  const { data } = useEngram(other);

  return (
    <Link to={relationHref(other)} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted">
      <span className="w-3 shrink-0 text-center text-muted-foreground">{outgoing ? "→" : "←"}</span>
      <span className="shrink-0 text-caption text-muted-foreground">{relation.relation}</span>
      {data && (
        <span className="shrink-0">
          <TypeBadge type={data.type} />
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-ui">{data ? engramLabel(data) : "…"}</span>
    </Link>
  );
}

// v0.14: a subject chip carries its lifecycle — active = green status badge,
// closed = grey + struck through. Rounded-rect (not a pill) with a status dot so
// it never reads as a tag pill or the amber review flag. Click = show the other
// engrams in this subject (across scopes).
function SubjectChip({ id, subject, open, onClick }: { id: string; subject?: Subject; open: boolean; onClick: () => void }) {
  const status = subject?.status ?? "active";
  const color = SUBJECT_STATUS_COLOR[status];
  const closed = status === "closed";
  return (
    <button
      type="button"
      onClick={onClick}
      title={`${subject?.description ?? subject?.name ?? id} · ${status} · click for the other engrams in this subject`}
      className="inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-caption transition-colors"
      style={{
        borderColor: withAlpha(color, open ? 0.9 : 0.5),
        backgroundColor: withAlpha(color, open ? 0.2 : 0.1),
        color: closed ? SUBJECT_STATUS_COLOR.closed : undefined,
      }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span className={closed ? "line-through" : "text-foreground"}>{subject?.name ?? id}</span>
      <span className="text-[10px] tracking-wide uppercase" style={{ color }}>{status}</span>
    </button>
  );
}

// The other engrams in one subject, across scopes — the subject lens's strand as a list.
function SubjectMembers({ subject, id, engramId, relationHref }: {
  subject?: Subject;
  id: string;
  engramId: string;
  relationHref: (otherId: string) => string;
}) {
  const { data, isLoading } = useSubjectMembers(id);
  const others = (data?.engrams ?? []).filter((e) => e.id !== engramId);
  return (
    <BrainCard className="px-3 py-3">
      <div className="px-1">
        <CardTitle>
          {subject?.name ?? id} · {others.length} other engram{others.length === 1 ? "" : "s"}
        </CardTitle>
        {subject?.description && <p className="-mt-1 mb-2 text-caption text-muted-foreground">{subject.description}</p>}
      </div>
      {isLoading ? (
        <p className="px-1 text-caption text-muted-foreground">Loading…</p>
      ) : others.length === 0 ? (
        <p className="px-1 text-caption text-muted-foreground">No other engrams in this subject yet.</p>
      ) : (
        <div className="flex flex-col gap-0.5">
          {others.map((e) => (
            <Link key={e.id} to={relationHref(e.id)} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted">
              <span className="shrink-0">
                <TypeBadge type={e.type} />
              </span>
              <span className="min-w-0 flex-1 truncate text-ui">{engramLabel(e)}</span>
              <span className="shrink-0 text-caption text-muted-foreground">{e.scope}</span>
            </Link>
          ))}
        </div>
      )}
    </BrainCard>
  );
}

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>;
}

// Shared engram body for the drawer (web also rendered it on a full page;
// the cockpit has no page routes — the drawer is the detail surface). How
// relation links resolve is the caller's: the drawer swaps `?engram=`.
export function EngramDetail({
  id,
  relationHref,
  projects,
  onLeave,
}: {
  id: string;
  relationHref: (otherId: string) => string;
  /** The cockpit's projects — a task offers a task run with them (v0.17). */
  projects?: Project[];
  /** Called when an action moves the user away from the drawer (a task run opens). */
  onLeave?: () => void;
}) {
  const { data: engram, isLoading, error } = useEngram(id);
  const subjectsQuery = useSubjects();
  const [openSubject, setOpenSubject] = useState<string | null>(null);

  if (isLoading) return <p className="text-ui text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-ui text-destructive">{(error as Error).message}</p>;
  if (!engram) return <p className="text-ui text-muted-foreground">Not found.</p>;

  const isTask = engram.type === "task";

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <TypeBadge type={engram.type} />
        <h1 className="text-heading font-semibold tracking-tight text-foreground">{engram.title ?? engram.type}</h1>
        {engram.labels?.includes(REVIEW_LABEL) && <ReviewFlag />}
      </div>

      <div className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span>{engram.scope}</span>
        <span>status: {engram.status}</span>
        <span>significance: {engram.significance}</span>
        {engram.ingested_by && <span>by {engram.ingested_by}</span>}
        <span>updated {engram.updated_at.slice(0, 10)}</span>
      </div>

      {engram.labels?.includes(REVIEW_LABEL) && <ReviewActions engram={engram} />}

      {engram.subjects && engram.subjects.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-caption tracking-wide text-muted-foreground/70 uppercase">Subjects</span>
          {engram.subjects.map((t) => (
            <SubjectChip
              key={t}
              id={t}
              subject={subjectsQuery.data?.subjects.find((x) => x.id === t)}
              open={openSubject === t}
              onClick={() => setOpenSubject((cur) => (cur === t ? null : t))}
            />
          ))}
        </div>
      )}

      {openSubject && engram.subjects?.includes(openSubject) && (
        <SubjectMembers
          id={openSubject}
          subject={subjectsQuery.data?.subjects.find((x) => x.id === openSubject)}
          engramId={engram.id}
          relationHref={relationHref}
        />
      )}

      {engram.tags && engram.tags.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="mr-0.5 text-caption tracking-wide text-muted-foreground/70 uppercase">Tags</span>
          {engram.tags.map((t) => (
            <span key={t} className="rounded-full border border-border bg-muted px-2 py-0.5 text-caption text-muted-foreground">
              {t}
            </span>
          ))}
        </div>
      )}

      {isTask && <TaskOutcome engram={engram} />}
      {isTask && <TaskStageCard engram={engram} />}
      {isTask && projects && <TaskRunCard engram={engram} projects={projects} onStarted={onLeave} />}

      <BrainCard className="px-4 py-3">
        <div className="text-body leading-relaxed whitespace-pre-wrap text-foreground">{engram.content}</div>
      </BrainCard>

      <EngramTail engram={engram} relationHref={relationHref} />
    </div>
  );
}

// Everything below the content: for a task the hub (parent / sub-tasks, linked
// decisions + notes) and the journal first (v0.15); then properties and the
// relations not already shown in the hub. Own component so the hub hook always runs.
function EngramTail({ engram, relationHref }: { engram: Engram; relationHref: (otherId: string) => string }) {
  const isTask = engram.type === "task";
  const hub = useTaskHub(engram);
  const relations = isTask ? hub.rest : (engram.relations ?? []);
  // stage + outcome have their own cards on a task
  const propEntries = Object.entries(engram.properties ?? {}).filter(
    ([k]) => !(isTask && (k === "stage" || k === "outcome")),
  );

  return (
    <>
      {isTask && (
        <TaskHubBlocks hub={hub} relationHref={relationHref} ParentRef={({ id }) => <EngramRef id={id} relationHref={relationHref} />} />
      )}
      {isTask && <TaskJournal engram={engram} relationHref={relationHref} />}

      {propEntries.length > 0 && (
        <BrainCard className="px-4 py-3">
          <CardTitle>Properties</CardTitle>
          <div className="flex flex-col gap-1 text-ui">
            {propEntries.map(([k, v]) => (
              <div key={k} className="flex gap-2">
                <span className="min-w-36 shrink-0 text-muted-foreground">{k}</span>
                <div className="min-w-0 flex-1 text-foreground">
                  <PropertyValue value={v} relationHref={relationHref} />
                </div>
              </div>
            ))}
          </div>
        </BrainCard>
      )}

      {relations.length > 0 && (
        <BrainCard className="px-3 py-3">
          <div className="px-1">
            <CardTitle>Relations ({relations.length})</CardTitle>
          </div>
          <div className="flex flex-col gap-0.5">
            {relations.map((r) => (
              <RelationItem key={r.id} relation={r} engramId={engram.id} relationHref={relationHref} />
            ))}
          </div>
        </BrainCard>
      )}
    </>
  );
}
