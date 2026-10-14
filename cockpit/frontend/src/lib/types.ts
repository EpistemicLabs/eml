// Mirror of the EML core API shapes we consume (read-only subset).
// Ported from packages/web/lib/types.ts. Source of truth: packages/core/src/types.ts.

export type EngramType =
  | "decision"
  | "rule"
  | "profile"
  | "status"
  | "task"
  | "event"
  | "log"
  | "reference"
  | "note";

export type EngramStatus =
  | "planned"
  | "active"
  | "superseded"
  | "invalidated"
  | "expired"
  | "resolved";

export type Significance = "critical" | "high" | "normal" | "low" | "trivial";

export type RelationType =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "derived_from"
  | "refines"
  | "related_to"
  | "blocks"
  | "part_of"; // v0.15: child task → parent task

export type ProjectStatus = "active" | "paused" | "archived";

export const REVIEW_LABEL = "review";

export interface Engram {
  id: string;
  content: string;
  type: EngramType;
  scope: string;
  title: string | null;
  status: EngramStatus;
  significance: Significance;
  properties: Record<string, unknown> | null;
  ingested_by: string | null;
  ingestion_method: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
  labels: string[];
  /** v0.14: subject ids this engram belongs to (cross-scope strands). */
  subjects: string[];
  relations?: Relation[];
  /** v0.15: a task's journal, oldest first (GET /engram/:id, tasks only). */
  entries?: TaskEntry[];
}

// v0.15: task stage (optional maturity) and journal entries.
export const TASK_STAGES = ["ideation", "planning", "ready", "implementation"] as const;
export type TaskStage = (typeof TASK_STAGES)[number];

/** What each stage means — tooltip text wherever a stage is shown. */
export const TASK_STAGE_HINTS: Record<TaskStage, string> = {
  ideation: "noted, not worked out yet",
  planning: "options and trade-offs being weighed",
  ready: "decided — decisions and plan settled, ready to implement",
  implementation: "being built",
};

export interface TaskEntry {
  id: string;
  task_id: string;
  at: string;
  author: string | null;
  stage: TaskStage | null;
  text: string;
}

/** v0.15: a task's stage, if it carries a valid one. */
export function taskStage(e: Pick<Engram, "type" | "properties">): TaskStage | null {
  const s = e.type === "task" ? e.properties?.stage : undefined;
  return typeof s === "string" && (TASK_STAGES as readonly string[]).includes(s) ? (s as TaskStage) : null;
}

// v0.14: a subject — a concrete strand with a lifecycle (the "heavy facet").
export type SubjectStatus = "active" | "closed";

export interface Subject {
  id: string;
  name: string;
  description: string | null;
  status: SubjectStatus;
  /** Members across the whole brain (every scope, any engram status). */
  engram_count: number;
  created_at: string;
  updated_at: string;
}

export interface SubjectsResponse {
  count: number;
  subjects: Subject[];
}

export interface Relation {
  id: string;
  source_id: string;
  target_id: string;
  relation: RelationType;
  detection_method: string;
  strength: number;
  explanation: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  goal: string | null;
  description: string | null;
  owner: string | null;
  parent_project: string | null;
  tags: string[] | null;
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectBrainState {
  project: Project;
  scope: string;
  current_status: Engram[];
  open_tasks: Engram[];
  recent_decisions: Engram[];
  recent_logs: Engram[];
  rules?: Engram[];
  relations?: Relation[];
}

export interface ListResponse {
  count: number;
  engrams: Engram[];
}

export interface RelationsResponse {
  count: number;
  relations: Relation[];
}

export interface ProjectsResponse {
  count: number;
  projects: Project[];
}

export interface StatsResponse {
  total_engrams: number;
  by_type: Record<string, number>;
  by_scope: Record<string, number>;
  agents: number;
  projects: number;
  users: number;
}
