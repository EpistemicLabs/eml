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
  | "note"
  | "learning"; // v0.19

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
  /** v0.19: the software that wrote it (cockpit-notes, …), and the session's model and harness. */
  origin?: string | null;
  model?: string | null;
  harness?: string | null;
  created_at: string;
  updated_at: string;
  tags: string[];
  labels: string[];
  /** v0.14: subject ids this engram belongs to (cross-scope strands). */
  subjects: string[];
  relations?: Relation[];
  /** v0.19: the engram's entries, oldest first (GET /engram/:id): a task's journal, a learning's evidence, review confirmations. */
  entries?: Entry[];
  /** v0.19: a task's bound decisions and notes (binding task, still active). */
  bound?: BoundItem[];
  /** v0.19: a learning's ripeness. */
  learning?: LearningState;
}

/** v0.19: an engram's append-only entry. note/change = task journal, evidence = learning, review = confirmation. */
export type EntryKind = "note" | "change" | "evidence" | "review";

export interface Entry {
  id: string;
  engram_id: string;
  kind: EntryKind;
  at: string;
  author: string | null;
  session_id: string | null;
  model: string | null;
  stage: TaskStage | null;
  text: string;
  source: "user" | "observed" | "self" | null;
  stance: "supports" | "contradicts" | "declined" | null;
  quote: string | null;
  rule_id: string | null;
}

/** v0.19: a decision or note bound to a task. */
export interface BoundItem {
  id: string;
  type: EngramType;
  title: string | null;
  status: EngramStatus;
}

export type LearningStateName = "collecting" | "ripe" | "unclear" | "paused";

export interface LearningState {
  state: LearningStateName;
  supporting_sessions: number;
  from_user: boolean;
  open_contradiction: boolean;
  declined_at: string | null;
}

/**
 * v0.19: the named fields of each type, in display order (core fields.ts
 * TYPE_FIELDS). Anything else in properties is shown under "other".
 */
export const TYPE_FIELD_ORDER: Record<EngramType, readonly string[]> = {
  decision: ["rationale", "alternatives", "binding", "expires_at", "review_due_at", "detail"],
  rule: ["applies", "trigger", "why", "agreed", "rule_type", "detail", "review_due_at"],
  profile: ["core", "detail", "review_due_at"],
  status: ["state", "next_step", "blockers", "detail"],
  task: ["context", "priority", "assignee_id", "due_date", "blockers", "stage", "outcome"],
  event: ["occurred_at", "change_type", "source_url", "detail"],
  log: ["what", "landed", "next", "open_threads", "detail"],
  reference: ["source", "source_name", "checked_at", "detail"],
  note: ["binding", "detail"],
  learning: [],
};

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

/** v0.15 name of a journal line; v0.19 it is an Entry of kind note or change. */
export type TaskEntry = Entry;

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
  started_at: string | null;
  ended_at: string | null;
  metadata: Record<string, unknown> | null;
  /** v0.19: what the project's status is about. */
  status_tracks?: string | null;
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
