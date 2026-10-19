import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { brainGet, brainPost } from "./api";
import { REVIEW_LABEL } from "./types";
import type {
  Engram,
  EngramStatus,
  EngramType,
  ListResponse,
  ProjectBrainState,
  ProjectsResponse,
  RelationsResponse,
  StatsResponse,
  TaskStage,
  SubjectsResponse,
} from "./types";

// Ported from packages/web/lib/queries.ts. Config/connect hooks dropped — the
// host auto-provisions. Same-origin /api/brain/* → host proxy → loopback brain.

type QueryClient = ReturnType<typeof useQueryClient>;

function invalidateReviewSurfaces(qc: QueryClient) {
  for (const key of [
    ["pending-reviews"],
    ["activity-by-day"],
    ["stats"],
    ["list"],
    ["project"],
    ["engram"],
  ]) {
    qc.invalidateQueries({ queryKey: key });
  }
}

export const keys = {
  projects: (status?: string) => ["projects", status ?? "all"] as const,
  project: (id: string) => ["project", id] as const,
  // Nested under ["project", id] so invalidateReviewSurfaces' ["project"] prefix covers it.
  projectEngrams: (id: string, filters?: unknown) => ["project", id, "engrams", filters] as const,
  engram: (id: string) => ["engram", id] as const,
  list: (filters: unknown) => ["list", filters] as const,
  recall: (query: string) => ["recall", query] as const,
};

export function useStats() {
  return useQuery({
    queryKey: ["stats"] as const,
    queryFn: () => brainGet<StatsResponse>("/stats"),
  });
}

export function useProjects(status?: string, enabled = true) {
  return useQuery({
    queryKey: keys.projects(status),
    queryFn: () => brainGet<ProjectsResponse>("/projects", { status }),
    enabled,
  });
}

export function useProject(
  id: string,
  enabled = true,
  options: { retry?: boolean | number | ((failureCount: number, error: Error) => boolean) } = {},
) {
  return useQuery({
    queryKey: keys.project(id),
    queryFn: () => brainGet<ProjectBrainState>(`/project/${id}`),
    enabled: enabled && !!id,
    ...options,
  });
}

export interface EngramFilters {
  type?: EngramType;
  status?: EngramStatus;
  limit?: number;
  offset?: number;
  order_by?: string;
}

export interface ProjectEngramFilters extends EngramFilters {
  significance?: string;
  title?: string;
  has_relations?: "true" | "false";
  assignee?: string;
  tag?: string;
  label?: string;
}

// GET /project/:id/engrams — scope-bound list with the project-engrams param
// set (packages/web/lib/queries.ts useProjectEngrams).
export function useProjectEngrams(id: string, filters: ProjectEngramFilters = {}, enabled = true) {
  return useQuery({
    queryKey: keys.projectEngrams(id, filters),
    queryFn: () => brainGet<ListResponse>(`/project/${id}/engrams`, { ...filters }),
    enabled: enabled && !!id,
  });
}

export function useProjectRelations(id: string, enabled = true) {
  return useQuery({
    queryKey: [...keys.project(id), "relations"] as const,
    queryFn: () => brainGet<RelationsResponse>(`/project/${id}/relations`),
    enabled: enabled && !!id,
  });
}

/** The single-engram query (shared by useEngram and batch loads via useQueries). */
export function engramQuery(id: string) {
  return {
    queryKey: keys.engram(id),
    queryFn: () => brainGet<Engram>(`/engram/${id}`, { with_relations: "true" }),
  };
}

export function useEngram(id: string, enabled = true) {
  return useQuery({ ...engramQuery(id), enabled: enabled && !!id });
}

export interface ListFilters extends EngramFilters {
  scope?: string;
  search?: string;
  significance?: string;
  /** v0.13.x server-side label filter (e.g. "review"). */
  label?: string;
  /** v0.14 server-side subject filter (membership, cross-scope). */
  subject?: string;
}

// v0.14: the subject registry (status + description + brain-wide member count).
// Small, so one call serves the lens hubs, the legend and the detail chips.
export function useSubjects() {
  return useQuery({
    queryKey: ["subjects"] as const,
    queryFn: () => brainGet<SubjectsResponse>("/subjects"),
  });
}

// v0.14: every engram in one subject, across scopes — the "other engrams in this
// subject" list in the engram drawer.
export function useSubjectMembers(subjectId: string, enabled = true) {
  return useList({ subject: subjectId, limit: 200, order_by: "updated_at" }, enabled && !!subjectId);
}

// v0.13: engrams currently flagged for review. One server call — the cockpit
// host bundles a brain with the `label=` list filter (v0.13.x), so no paged
// client-side scan as packages/web had to do.
export function usePendingReviews() {
  return useQuery({
    queryKey: ["pending-reviews"] as const,
    queryFn: async () => {
      const res = await brainGet<ListResponse>("/list", { label: REVIEW_LABEL, order_by: "created_at", limit: 200 });
      return res.engrams;
    },
  });
}

// Engram creation bucketed per day (YYYY-MM-DD), for the activity heatmap +
// click-to-open-a-day. Pages cross-scope /list (created_at desc) up to a cap.
// (packages/web/lib/queries.ts useActivityByDay, verbatim.)
export function useActivityByDay() {
  return useQuery({
    queryKey: ["activity-by-day"] as const,
    queryFn: async () => {
      const byDay: Record<string, Engram[]> = {};
      for (let offset = 0; offset < 1200; offset += 200) {
        const res = await brainGet<ListResponse>("/list", { order_by: "created_at", limit: 200, offset });
        for (const e of res.engrams) {
          const day = e.created_at.slice(0, 10);
          (byDay[day] ??= []).push(e);
        }
        if (res.engrams.length < 200) break;
      }
      const counts: Record<string, number> = {};
      for (const [day, list] of Object.entries(byDay)) counts[day] = list.length;
      return { counts, byDay };
    },
  });
}

export function useList(filters: ListFilters, enabled = true) {
  return useQuery({
    queryKey: keys.list(filters),
    queryFn: () => brainGet<ListResponse>("/list", { ...filters }),
    enabled,
  });
}

export interface RecallResult {
  query: string;
  engrams: number;
  markdown: string;
}

export function useRecall(query: string, enabled = true) {
  return useQuery({
    queryKey: keys.recall(query),
    queryFn: () => brainPost<RecallResult>("/recall", { query, limit: 20 }),
    enabled: enabled && query.trim().length > 0,
  });
}

// --- Review triage (v0.13 write path). ---

// v0.19: a confirmation is a review entry — a decision, rule or profile says
// why it still holds (text required); a task confirms as a movement.
export function useConfirmReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; text?: string }) =>
      brainPost<{ engram: Engram }>(`/engram/${vars.id}/confirm-review`, vars.text ? { text: vars.text } : {}),
    onSuccess: () => invalidateReviewSurfaces(qc),
  });
}

// Retire: expired for decision/rule/profile; a task is invalidated with an
// outcome instead (tasks don't expire — spec v0.15 decision 20).
export function useRetireEngram() {
  const qc = useQueryClient();
  return useMutation({
    // v0.19: a task closes through /task/:id/track (outcome + text); everything else via /update.
    mutationFn: (engram: Pick<Engram, "id" | "type">) =>
      engram.type === "task"
        ? brainPost<Engram>(`/task/${engram.id}/track`, {
          status: "invalidated", outcome: "retired in review", text: "Retired in the cockpit review.",
        })
        : brainPost<Engram>("/update", { id: engram.id, patch: { status: "expired" } }),
    onSuccess: () => invalidateReviewSurfaces(qc),
  });
}

// v0.15: append a task entry. v0.19: POST /task/:id/track with text (a note
// entry); a stage rides along and is set on the task (a change entry). Any
// entry is a movement — it also clears the review flag.
export function useAddTaskEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: { taskId: string; text: string; stage?: TaskStage }) =>
      brainPost<Engram>(`/task/${vars.taskId}/track`, vars.stage ? { text: vars.text, stage: vars.stage } : { text: vars.text }),
    onSuccess: () => invalidateReviewSurfaces(qc),
  });
}

// New task → follow-up task in the engram's scope, linked back derived_from.
// (packages/web/lib/queries.ts useCreateReviewTask, verbatim.)
export function useCreateReviewTask() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { engram: Engram; content: string }) => {
      // v0.19: a task needs a title; origin marks the cockpit's triage.
      const task = await brainPost<Engram>("/engram/task", {
        content: vars.content,
        scope: vars.engram.scope,
        title: followUpTitle(vars.content),
        origin: "cockpit-review-triage",
      });
      await brainPost("/relate", {
        source_id: task.id,
        target_id: vars.engram.id,
        relation: "derived_from",
        detection_method: "manual",
        explanation: "Follow-up task from cockpit review triage",
      });
      return task;
    },
    onSuccess: () => invalidateReviewSurfaces(qc),
  });
}

/** A kebab-case title from the first words of the content, with a short suffix so it stays unique. */
export function followUpTitle(content: string): string {
  const slug = content
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-")
    .slice(0, 48)
    .replace(/-+$/, "");
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${slug || "follow-up"}-${suffix}`;
}

export { REVIEW_LABEL };
