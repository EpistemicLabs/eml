// The brain dashboard — the Brain tab's start page. Data flow and structure
// ported from packages/web/app/page.tsx (search, Snapshot + heatmap,
// Projects grid with all/work/life + Archived, Recent activity / Open tasks /
// Pending reviews); rendered in the cockpit's own look (see ./ui.tsx), with
// page navigation through the surface's nav (BrainLink / useBrainNav) and
// engram rows opening the global drawer as everywhere else.
import { useMemo, useState, type FormEvent } from "react";

import { useList, usePendingReviews, useProjects, useStats } from "@/lib/queries";
import type { Engram, Project } from "@/lib/types";
import { EngramRow, formatDate } from "@/components/engram-row";
import { TYPE_COLORS } from "@/components/ui/badge";
import { Button, Input } from "@/shared/view/ui";
import { ActivityHeatmap } from "./ActivityHeatmap";
import BrainLink from "./BrainLink";
import { useBrainNav } from "./BrainSurface";
import { BrainCard, EmptyNote, ListPanel, SectionHeader, Segmented, ToggleChip } from "./ui";
import { STAGE_FILTER_OPTIONS, TaskRow, byLastUpdate, filterByStage, type StageFilter } from "@/components/task-sections";
import { useEngramPanel } from "@/lib/engram-panel";

// Brain spaces: the project list is filtered by space.
// Until spaces exist there is one, "main", and it is the default; "all
// spaces" shows everything. The ported work/life view is gone.
type SpaceFilter = "all" | "main";
const SPACES: ReadonlyArray<{ value: SpaceFilter; label: string }> = [
  { value: "all", label: "all spaces" },
  { value: "main", label: "main" },
];

const REVIEW_ACCENT = "var(--color-review)"; // amber, same hue as the decision type

function StatStrip({ items }: { items: { n: number; label: string; color?: string }[] }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-3">
      {items.map((it) => (
        <div key={it.label}>
          <div className="text-heading font-semibold leading-tight tabular-nums text-foreground">{it.n}</div>
          <div className="flex items-center gap-1 text-caption text-muted-foreground">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: it.color ?? "var(--color-muted-foreground)" }} />
            <span className="truncate">{it.label}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  status,
  openTasks,
  lastActivity,
}: {
  project: Project;
  status?: Engram;
  openTasks: number;
  lastActivity?: string;
}) {
  const green = TYPE_COLORS.status;
  const headline =
    (status?.properties?.state as string) ??
    status?.content.split("\n").find((l) => l.trim()) ??
    null;
  return (
    <BrainLink
      to={{ view: "project", projectId: project.id }}
      className="flex items-center gap-4 rounded-lg border border-foreground/8 bg-foreground/[0.03] px-3 py-2.5 transition-colors hover:border-foreground/15 hover:bg-foreground/[0.06]"
    >
      <div className="min-w-0 flex-1">
        <div className="truncate text-body font-semibold text-foreground">{project.name}</div>
        {headline ? (
          <div className="mt-1 flex items-start gap-1.5">
            <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: green }} />
            <span className="line-clamp-1 text-ui text-muted-foreground">{headline}</span>
          </div>
        ) : (
          <div className="mt-1 text-ui text-muted-foreground/60">No status</div>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5 text-caption tabular-nums text-muted-foreground">
        {lastActivity && <span>{lastActivity}</span>}
        <span>{openTasks} tasks</span>
      </div>
    </BrainLink>
  );
}

function daysAgo(iso: string): string {
  const then = new Date(iso.replace(" ", "T"));
  const ms = Date.now() - then.getTime();
  const d = Math.floor(ms / 86_400_000);
  if (d <= 0) return "today";
  if (d === 1) return "yesterday";
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export default function BrainHome() {
  const { go } = useBrainNav();
  const [space, setSpace] = useState<SpaceFilter>("main");
  const [showArchived, setShowArchived] = useState(false);
  const [q, setQ] = useState("");
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [taskStageFilter, setTaskStageFilter] = useState<StageFilter>("all");
  const { hrefFor, setSource } = useEngramPanel();

  const stats = useStats();
  const projects = useProjects();
  const statuses = useList({ type: "status", status: "active", limit: 200 });
  const tasksAll = useList({ type: "task", limit: 200 });
  const recent = useList({ order_by: "created_at", limit: 200 });
  const pendingReviews = usePendingReviews();

  const statusByScope = useMemo(() => {
    const m = new Map<string, Engram>();
    for (const s of statuses.data?.engrams ?? []) {
      if (!m.has(s.scope)) m.set(s.scope, s); // newest wins (list is desc)
    }
    return m;
  }, [statuses.data]);

  const openTasks = useMemo(
    () => (tasksAll.data?.engrams ?? []).filter((e) => e.status === "planned" || e.status === "active"),
    [tasksAll.data],
  );

  const taskCountByScope = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of openTasks) m.set(t.scope, (m.get(t.scope) ?? 0) + 1);
    return m;
  }, [openTasks]);

  const lastActivityByScope = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of recent.data?.engrams ?? []) {
      if (!m.has(e.scope)) m.set(e.scope, e.created_at); // list is desc
    }
    return m;
  }, [recent.data]);

  // Recent activity excludes logs — session logs are their own type, kept out
  // of the activity feed to avoid drowning it.
  const recentActivity = useMemo(
    () => (recent.data?.engrams ?? []).filter((e) => e.type !== "log"),
    [recent.data],
  );

  // A selected heatmap day narrows the activity list to that day.
  const byDay = useMemo(() => {
    const m: Record<string, Engram[]> = {};
    for (const e of recent.data?.engrams ?? []) (m[e.created_at.slice(0, 10)] ??= []).push(e);
    return m;
  }, [recent.data]);

  // Archived projects are clutter in the default cockpit — hidden unless the
  // "Archived" toggle is on, which then shows *only* them (still work/life-scoped).
  const visibleProjects = useMemo(() => {
    const list = (projects.data?.projects ?? []).filter(
      // One space so far — every project is in "main" as well as in "all".
      (p) => (space === "all" || space === "main") && (showArchived ? p.status === "archived" : p.status !== "archived"),
    );
    return list.sort((a, b) => {
      const la = lastActivityByScope.get(`project.${a.id}`) ?? "";
      const lb = lastActivityByScope.get(`project.${b.id}`) ?? "";
      return la < lb ? 1 : la > lb ? -1 : 0;
    });
  }, [projects.data, space, showArchived, lastActivityByScope]);

  const archivedCount = useMemo(
    () => (projects.data?.projects ?? []).filter((p) => p.status === "archived").length,
    [projects.data],
  );

  function search(e: FormEvent) {
    e.preventDefault();
    if (q.trim()) go({ view: "search", q: q.trim() });
  }

  // Ordered ids per bottom-row list, so the drawer can page through exactly the
  // list a row was clicked from (each column is its own paging context).
  const recentList = selectedDay ? (byDay[selectedDay] ?? []) : recentActivity.slice(0, 20);
  const recentIds = recentList.map((e) => e.id);
  // v0.15: newest update first — no priority sort until priority-significance-rework.
  const stagedOpenTasks = byLastUpdate(filterByStage(openTasks, taskStageFilter));
  const openTaskRows = stagedOpenTasks.slice(0, 30);
  const openTaskIds = openTaskRows.map((e) => e.id);
  const pendingReviewRows = pendingReviews.data ?? [];
  const pendingReviewIds = pendingReviewRows.map((e) => e.id);

  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={search} className="flex gap-2">
        <Input placeholder="Search the brain…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Button type="submit" variant="secondary" size="sm" className="h-9">Search</Button>
      </form>

      {/* Top: snapshot (left) + projects (right), matched height */}
      <div className="grid items-start gap-4 @3xl:grid-cols-3">
        <BrainCard className="p-4 @3xl:h-[420px]">
          <SectionHeader title="Snapshot" />
          {/* Row 1: what the brain holds · row 2: what wants attention.
              The third tile of row 2 stays empty. */}
          <StatStrip
            items={[
              { n: stats.data?.total_engrams ?? 0, label: "engrams" },
              { n: stats.data?.projects ?? 0, label: "projects" },
              { n: stats.data?.by_type.log ?? 0, label: "sessions", color: TYPE_COLORS.log },
              { n: openTasks.length, label: "open tasks", color: TYPE_COLORS.task },
              { n: pendingReviewRows.length, label: "pending reviews", color: REVIEW_ACCENT },
            ]}
          />
          <div className="mt-4 border-t border-foreground/15 pt-4">
            <ActivityHeatmap selectedDay={selectedDay} onSelectDay={setSelectedDay} />
          </div>
        </BrainCard>

        <BrainCard className="flex flex-col p-4 @3xl:col-span-2 @3xl:h-[420px]">
          <SectionHeader
            title="Projects"
            right={
              <div className="flex items-center gap-1.5">
                <Segmented value={space} options={SPACES} onChange={setSpace} ariaLabel="Brain space" />
                {archivedCount > 0 && (
                  <ToggleChip
                    active={showArchived}
                    onClick={() => setShowArchived((s) => !s)}
                    title="Show archived projects"
                  >
                    Archived {archivedCount}
                  </ToggleChip>
                )}
              </div>
            }
          />
          {projects.isLoading ? (
            <EmptyNote>Loading…</EmptyNote>
          ) : projects.error ? (
            <EmptyNote>Failed to reach the brain.</EmptyNote>
          ) : visibleProjects.length === 0 ? (
            <EmptyNote>No projects in this space.</EmptyNote>
          ) : (
            <div className="grid min-h-0 flex-1 grid-cols-1 content-start gap-2 overflow-y-auto pr-1 @xl:grid-cols-2">
              {visibleProjects.map((p) => {
                const last = lastActivityByScope.get(`project.${p.id}`);
                return (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    status={statusByScope.get(`project.${p.id}`)}
                    openTasks={taskCountByScope.get(`project.${p.id}`) ?? 0}
                    lastActivity={last ? daysAgo(last) : undefined}
                  />
                );
              })}
            </div>
          )}
        </BrainCard>
      </div>

      {/* Middle — the two lists that want attention, half / half: open tasks · pending reviews */}
      <div className="grid gap-4 @3xl:grid-cols-2">
        <ListPanel
          title="Open tasks"
          accent={TYPE_COLORS.task}
          action={
            <div className="flex items-center gap-2">
              <Segmented value={taskStageFilter} options={STAGE_FILTER_OPTIONS} onChange={setTaskStageFilter} ariaLabel="Filter open tasks by stage" />
              <span className="text-caption tabular-nums text-muted-foreground">{stagedOpenTasks.length}</span>
            </div>
          }
        >
          {openTaskRows.length === 0 ? (
            <EmptyNote>{openTasks.length === 0 ? "No open tasks." : "No open tasks at this stage."}</EmptyNote>
          ) : (
            openTaskRows.map((t) => (
              <TaskRow key={t.id} task={t} showScope href={hrefFor(t.id)} onOpen={() => setSource(openTaskIds)} />
            ))
          )}
        </ListPanel>
        {/* v0.13: engrams due for a review (review_due_at passed; v0.15: active
            tasks without movement for 30 days). Amber, matches the ReviewFlag. */}
        <ListPanel title="Pending reviews" accent={REVIEW_ACCENT} count={pendingReviewRows.length}>
          {pendingReviewRows.length === 0 ? (
            <EmptyNote>Nothing to review.</EmptyNote>
          ) : (
            pendingReviewRows.map((e) => <EngramRow key={e.id} engram={e} showScope siblings={pendingReviewIds} />)
          )}
        </ListPanel>
      </div>

      {/* Bottom — recent activity (every box but tasks is 1/3) */}
      <div className="grid gap-4 @3xl:grid-cols-3">
        <ListPanel
          title={selectedDay ? `Activity · ${formatDate(selectedDay)}` : "Recent activity"}
          accent={TYPE_COLORS.status}
          action={
            selectedDay ? (
              <button
                type="button"
                onClick={() => setSelectedDay(null)}
                className="text-caption text-muted-foreground hover:text-foreground"
              >
                clear ✕
              </button>
            ) : undefined
          }
        >
          {recentList.length === 0 ? (
            <EmptyNote>Nothing yet.</EmptyNote>
          ) : (
            recentList.map((e) => <EngramRow key={e.id} engram={e} showScope siblings={recentIds} />)
          )}
        </ListPanel>
      </div>
    </div>
  );
}
