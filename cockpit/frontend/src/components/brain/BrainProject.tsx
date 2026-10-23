// The project page of the brain surface. Data flow ported from
// packages/web/app/project/[id]/page.tsx (breadcrumb, title + goal,
// project-scoped live search that replaces the body, status banner paging
// through the auto-superseded history, then Open tasks · Decisions ·
// References and Rules · Logs), rendered in the cockpit look (./ui.tsx).
// The graph lenses (timeline / tags / relations) sit between the status
// banner and the columns (./GraphPanel.tsx).
import { useState } from "react";
import { Link } from "react-router";

import { ApiError } from "@/lib/api";
import { useEngramPanel } from "@/lib/engram-panel";
import { useList, useProject, useProjectEngrams, useProjects } from "@/lib/queries";
import { type Engram, type EngramType } from "@/lib/types";
import { EngramRow, formatDate } from "@/components/engram-row";
import { TYPE_COLORS } from "@/components/ui/badge";
import { Input } from "@/shared/view/ui";
import BrainLink from "./BrainLink";
import { BackLink, useBrainNav } from "./BrainSurface";
import GraphPanel from "./GraphPanel";
import { BrainCard, EmptyNote, ListPanel, Pager, SectionHeader, Segmented } from "./ui";
import { STAGE_FILTER_OPTIONS, TaskRow, byLastUpdate, filterByStage, type StageFilter } from "@/components/task-sections";

// A scrollable column: title + count, ~7 rows visible, rest scrolls.
function ScrollColumn({
  title,
  type,
  engrams,
  empty = "—",
}: {
  title: string;
  type: EngramType;
  engrams: Engram[];
  empty?: string;
}) {
  const ids = engrams.map((e) => e.id);
  return (
    <ListPanel title={title} accent={TYPE_COLORS[type] ?? "var(--color-muted-foreground)"} count={engrams.length} className="min-h-0">
      {engrams.length === 0 ? (
        <EmptyNote>{empty}</EmptyNote>
      ) : (
        engrams.map((e) => <EngramRow key={e.id} engram={e} hideType siblings={ids} />)
      )}
    </ListPanel>
  );
}

const REVIEW_ACCENT = "var(--color-review)"; // amber, same hue as the decision type

// v0.15: the open-tasks panel (half width, next to pending reviews) — lean task rows, newest update first,
// filterable by stage. Loads the project's tasks itself: the brain state's
// open_tasks is capped at 10 and priority-sorted (priority-significance-rework).
function OpenTasksPanel({ projectId, live, className }: { projectId: string; live: boolean; className?: string }) {
  const [stage, setStage] = useState<StageFilter>("all");
  const { hrefFor, setSource } = useEngramPanel();
  const all = useProjectEngrams(projectId, { type: "task", order_by: "updated_at", limit: 200 }, live);
  const open = byLastUpdate((all.data?.engrams ?? []).filter((t) => t.status === "planned" || t.status === "active"));
  const shown = filterByStage(open, stage);
  const ids = shown.map((e) => e.id);
  return (
    <ListPanel
      title="Open tasks"
      accent={TYPE_COLORS.task}
      className={`min-h-0 ${className ?? ""}`}
      action={
        <div className="flex items-center gap-2">
          <Segmented value={stage} options={STAGE_FILTER_OPTIONS} onChange={setStage} ariaLabel="Filter open tasks by stage" />
          <span className="text-caption tabular-nums text-muted-foreground">{shown.length}</span>
        </div>
      }
    >
      {all.isLoading ? (
        <EmptyNote>Loading…</EmptyNote>
      ) : shown.length === 0 ? (
        <EmptyNote>{open.length === 0 ? "No open tasks." : "No open tasks at this stage."}</EmptyNote>
      ) : (
        shown.map((e) => <TaskRow key={e.id} task={e} href={hrefFor(e.id)} onOpen={() => setSource(ids)} />)
      )}
    </ListPanel>
  );
}

// Status pager — newest status in front, page back through the auto-superseded
// history (statuses share a scope and supersede one another over time).
function StatusBanner({ statuses }: { statuses: Engram[] }) {
  const ordered = [...statuses].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const [i, setI] = useState(0);
  const { hrefFor, setSource } = useEngramPanel();
  if (ordered.length === 0) return null;
  const idx = Math.min(i, ordered.length - 1);
  const s = ordered[idx];
  const accent = TYPE_COLORS.status;
  const isCurrent = s.status === "active";
  const dot = isCurrent ? accent : "var(--color-muted-foreground)";
  const state =
    (s.properties?.state as string | undefined) ??
    s.content.split("\n").find((l) => l.trim()) ??
    null;
  const next = (s.properties?.next_step as string | undefined) ?? null;

  return (
    <BrainCard className="border-l-[3px] p-4" style={{ borderLeftColor: dot }}>
      <SectionHeader
        title={isCurrent ? "Status" : "Status · superseded"}
        accent={dot}
        className="mb-2"
        right={
          <div className="flex items-center gap-3">
            <span className="text-caption text-muted-foreground">{formatDate(s.created_at)}</span>
            {ordered.length > 1 && (
              <Pager index={idx} total={ordered.length} onChange={setI} olderTitle="Older status" newerTitle="Newer status" />
            )}
          </div>
        }
      />
      <Link to={hrefFor(s.id)} onClick={() => setSource(null)} className="block">
        {state && <div className="text-body font-semibold text-foreground hover:underline">{state}</div>}
        <p className="mt-1 line-clamp-2 text-ui text-muted-foreground">{s.content}</p>
      </Link>
      {next && (
        <div className="mt-3 flex items-start gap-2 rounded-lg bg-foreground/[0.04] px-3 py-2 text-ui text-muted-foreground">
          <span className="mt-px shrink-0 text-caption font-semibold tracking-wide uppercase" style={{ color: accent }}>
            Next
          </span>
          <span className="line-clamp-2">{next}</span>
        </div>
      )}
    </BrainCard>
  );
}

export default function BrainProject({ projectId }: { projectId: string }) {
  const { home } = useBrainNav();
  const id = projectId;

  const state = useProject(id, true, {
    // A missing project is an answer, not a transient failure — show it at once.
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 1,
  });
  const allProjects = useProjects();
  const [q, setQ] = useState("");
  const searching = q.trim().length > 0;
  const searchResults = useList({ search: q, scope: `project.${id}`, limit: 50 }, searching);
  // The column queries run in parallel with the project itself; once it has
  // failed (404), they stop — no point retrying five lists for a missing id.
  const live = !state.isError;
  const statusHistory = useProjectEngrams(id, { type: "status", order_by: "created_at", limit: 50 }, live);
  const decisions = useProjectEngrams(id, { type: "decision", order_by: "created_at", limit: 25 }, live);
  const references = useProjectEngrams(id, { type: "reference", order_by: "created_at", limit: 25 }, live);
  const notes = useProjectEngrams(id, { type: "note", order_by: "created_at", limit: 25 }, live);
  const rules = useProjectEngrams(id, { type: "rule", limit: 25 }, live);
  const logs = useProjectEngrams(id, { type: "log", order_by: "created_at", limit: 25 }, live);
  const reviews = useProjectEngrams(id, { review_due: "true", order_by: "created_at", limit: 50 }, live);

  const project = state.data?.project;
  const parentId = project?.parent_project ?? null;
  const parentName =
    (parentId && allProjects.data?.projects.find((p) => p.id === parentId)?.name) || parentId;

  const breadcrumb = (
    <div className="flex items-center gap-2 text-ui text-muted-foreground">
      <BackLink onClick={home}>← Dashboard</BackLink>
      {parentId && (
        <>
          <span>/</span>
          <BrainLink to={{ view: "project", projectId: parentId }} className="truncate hover:text-foreground hover:underline">
            {parentName}
          </BrainLink>
        </>
      )}
    </div>
  );

  if (state.error) {
    const notFound = state.error instanceof ApiError && state.error.status === 404;
    return (
      <div className="flex flex-col gap-4">
        {breadcrumb}
        <BrainCard className="px-4 py-4">
          <div className="text-body font-semibold text-foreground">{notFound ? "Project not found" : "Failed to load project"}</div>
          <p className="mt-1 text-ui text-muted-foreground">
            {notFound ? (
              <>No brain project with id <span className="font-mono">{id}</span>.</>
            ) : (
              (state.error as Error).message
            )}
          </p>
        </BrainCard>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div>
        {breadcrumb}
        <h1 className="mt-1 text-heading font-semibold text-foreground">{project?.name ?? id}</h1>
        {project?.goal && <p className="mt-1 text-body text-muted-foreground">{project.goal}</p>}
        {project?.description && <p className="mt-1 text-caption text-muted-foreground/80">{project.description}</p>}
      </div>

      {/* Project-scoped search — filters to this project only */}
      <div className="relative">
        <Input placeholder={`Search ${project?.name ?? "this project"}…`} value={q} onChange={(e) => setQ(e.target.value)} />
        {searching && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="absolute top-1/2 right-3 -translate-y-1/2 text-caption text-muted-foreground hover:text-foreground"
          >
            clear ✕
          </button>
        )}
      </div>

      {state.isLoading ? (
        <EmptyNote>Loading…</EmptyNote>
      ) : searching ? (
        /* Search mode — only this project's matches */
        <ListPanel
          title="Results"
          count={searchResults.data?.count}
          action={searchResults.isLoading ? <span className="text-caption text-muted-foreground">…</span> : undefined}
        >
          {searchResults.error ? (
            <EmptyNote>{(searchResults.error as Error).message}</EmptyNote>
          ) : searchResults.isLoading ? (
            <EmptyNote>Searching…</EmptyNote>
          ) : (searchResults.data?.count ?? 0) === 0 ? (
            <EmptyNote>No matches in this project for “{q}”.</EmptyNote>
          ) : (
            searchResults.data?.engrams.map((e) => (
              <EngramRow key={e.id} engram={e} siblings={searchResults.data?.engrams.map((x) => x.id)} />
            ))
          )}
        </ListPanel>
      ) : (
        <>
          {/* 1 — Status (pager: current + superseded history) */}
          <StatusBanner statuses={statusHistory.data?.engrams ?? []} />

          {/* 2 — Graph lenses (timeline | tags | relations, filters, toggles) */}
          <GraphPanel projectId={id} />

          {/* 3 — the two lists that want attention, half / half: open tasks · pending reviews */}
          <div className="grid gap-4 @3xl:grid-cols-2">
            <OpenTasksPanel projectId={id} live={live} />
            <ListPanel title="Pending reviews" accent={REVIEW_ACCENT} count={reviews.data?.engrams.length ?? 0} className="min-h-0">
              {(reviews.data?.engrams.length ?? 0) === 0 ? (
                <EmptyNote>Nothing to review.</EmptyNote>
              ) : (
                reviews.data?.engrams.map((e) => (
                  <EngramRow key={e.id} engram={e} siblings={reviews.data?.engrams.map((x) => x.id)} />
                ))
              )}
            </ListPanel>
          </div>

          {/* 4 — Decisions · References · Notes */}
          <div className="grid gap-4 @3xl:grid-cols-3">
            <ScrollColumn title="Decisions" type="decision" engrams={decisions.data?.engrams ?? []} />
            <ScrollColumn title="References" type="reference" engrams={references.data?.engrams ?? []} />
            <ScrollColumn title="Notes" type="note" engrams={notes.data?.engrams ?? []} />
          </div>

          {/* 5 — Rules · Logs (profiles are identity, not project work). Every box but tasks is 1/3. */}
          <div className="grid gap-4 @3xl:grid-cols-3">
            <ScrollColumn title="Rules" type="rule" engrams={rules.data?.engrams ?? []} />
            <ScrollColumn title="Logs" type="log" engrams={logs.data?.engrams ?? []} />
          </div>
        </>
      )}
    </div>
  );
}
