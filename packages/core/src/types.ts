// ============================================================
// EML v0.8 Types
// ============================================================

// === Enums ===

// v0.8 C8: EngramType (was: KnowledgeType). Column engrams.type (was: engrams.knowledge_type).
export type EngramType =
  | 'decision' | 'rule' | 'profile' | 'status'
  | 'task' | 'event' | 'log'                                      // v0.3
  | 'reference'                                                   // v0.7
  | 'note'                                                        // v0.14

export const ENGRAM_TYPES: readonly EngramType[] = [
  'decision', 'rule', 'profile', 'status', 'task', 'event', 'log', 'reference', 'note',
]

export type EngramStatus = 'planned' | 'active' | 'superseded' | 'invalidated' | 'expired' | 'resolved'

// v0.8 C9: brain hygiene review — default days until review_due_at for the
// types that have no automatic lifecycle (decisions, rules, profiles).
// Other types need no review:
// - status/task: lifecycle via status + auto-supersede
// - event/log: historical facts, fixed
// - reference: link validation instead of time decay (v0.10+)
// - note (v0.14): a standing thought in the brain, no time decay, no review
export const TYPE_REVIEW_DEFAULTS: Partial<Record<EngramType, number>> = {
  decision: 60,
  rule:     90,
  profile:  180,
}

// v0.8 C1: per-type default status — every type defaults to 'active', except task='planned'.
// Engrams.store() uses this map as the fallback when the input has no status.
// Tasks always start as 'planned' (workflow lifecycle: planned → active → resolved).
export const TYPE_DEFAULT_STATUS: Record<EngramType, EngramStatus> = {
  decision:    'active',
  rule:        'active',
  profile:     'active',
  status:      'active',
  task:        'planned',  // task default: planned (not active)
  event:       'active',
  log:         'active',
  reference:   'active',
  note:        'active',   // v0.14
}
export type Significance = 'critical' | 'high' | 'normal' | 'low' | 'trivial'
export type DetectionMethod = 'manual' | 'agent_declared' | 'auto_temporal' | 'auto_semantic'
export type RelationType =
  | 'supports' | 'contradicts' | 'supersedes'
  | 'derived_from' | 'refines' | 'related_to'
  | 'blocks'                                                      // v0.3
  | 'part_of'                                                     // v0.15: child task → parent task
// v0.8 C7: ingestion_method values simplified.
//   hook   → automatically via a system hook (post-session, scheduled cron)
//   direct → explicit call (POST /context)
//   bulk   → migration / mass import
//   other  → catch-all
export type IngestionMethod = 'hook' | 'direct' | 'bulk' | 'other'

// v0.9.1 Cluster 1: SourceType type removed (source_id/source_type dropped from the schema).

// === Properties (type-specific) ===

// Decision (v0.8 C7: + decision_type Enum, + review_due_at)
// v0.15: decision_type is no longer written (eml_decide dropped it); the type stays
// for legacy data. rationale + alternatives (≥ 1) are required on CREATE
// (validateProperties) — optional here because legacy decisions may lack them.
export type DecisionType = 'strategic' | 'architectural' | 'operational' | 'roadmap'

export interface DecisionProperties {
  decision_type?: DecisionType
  rationale?: string
  alternatives?: string[]
  expires_at?: string             // hard lifecycle: obsolete from then on
  review_due_at?: string          // C9 soft review (default 60d)
}

// Rule (v0.8 C7: + rule_type Enum, + review_due_at)
// v0.10.8: `enforcement` (strength: mandatory/recommended/advisory) replaced by
// `applies` (applicability: always/situational). A rule has no weak tier — when it
// applies, it is binding. `always` = ambient within its scope; `situational` =
// context-gated, then fully binding. See docs/specs/v0.10.8-PROPOSAL.md.
export type Applicability = 'always' | 'situational'
export type RuleType = 'constraint' | 'process' | 'convention' | 'behavior' | 'security'

export interface RuleProperties {
  applies: Applicability
  rule_type?: RuleType
  applies_to?: string[]
  context?: string
  review_due_at?: string          // C9 (default 90d)
}

// Profile (v0.5)
// Note: ProfileType removed entirely in v0.5 — core identity data now lives
// in the users/agents tables (first-class entities). profile engrams remain for
// facets about users/agents (workstyle, travel, family etc.) — scope=user.<id>
// or scope=agent.<id>, title carries the facet info.
// v0.8 C7: + review_due_at (default 180d). Remaining fields ad hoc/free text —
// a structured schema pass comes before v1.0.
export interface ProfileProperties {
  review_due_at?: string          // C9 (default 180d)
}

// Status (v0.8 C7: status_type/subject_state/phase gone; state required, blockers new)
export interface StatusProperties {
  state: string                   // required — short snapshot ("v0.7 deployed")
  next_step?: string
  blockers?: string[]
}

// Task (v0.3) — planned action with a workflow lifecycle
// v0.8 C7: + blockers
// v0.15: status answers "open, in progress, or how closed" — planned = open, not
// started or parked · active = started, not finished · resolved/invalidated =
// closed (outcome required on the transition) · superseded = replaced. Blocked is
// not a status (blockers). stage answers "how mature is the work" (optional,
// frozen once the task is closed).
export type TaskPriority = 'urgent' | 'high' | 'normal' | 'low'

export const TASK_STAGES = ['ideation', 'planning', 'ready', 'implementation'] as const
export type TaskStage = typeof TASK_STAGES[number]

/** v0.15: task statuses that are open (boot's open_tasks, the inactivity review). */
export const TASK_OPEN_STATUSES: readonly EngramStatus[] = ['planned', 'active']
/** v0.15: task statuses that close a task with a result — the transition needs an outcome. */
export const TASK_OUTCOME_STATUSES: readonly EngramStatus[] = ['resolved', 'invalidated']
/** v0.15: an open task without movement (patch or entry) for this long gets the review label. */
export const TASK_INACTIVITY_DAYS = 30

export interface TaskProperties {
  due_date?: string               // ISO date
  assignee_id?: string            // → agents.id; optional = unassigned
  priority?: TaskPriority         // execution urgency (≠ significance)
  context?: string                // short note on why
  blockers?: string[]
  stage?: TaskStage               // v0.15: maturity of the work (optional)
  outcome?: string                // v0.15: short result on close (resolved/invalidated)
  // no review_due_at — stale tasks surface by inactivity (TASK_INACTIVITY_DAYS)
}

/** v0.15: one line in a task's append-only journal (task_entries). */
export interface TaskEntry {
  id: string
  task_id: string
  at: string                      // ISO-8601, set on append
  author: string | null           // ingested-by handle of the caller
  stage: TaskStage | null         // stage at the time of the entry (or the new stage)
  text: string
}

/**
 * v0.15: the edge a task-linked write draws to its task (X → task). A decision
 * taken in the task originates from it (derived_from); a note — its plan, a rule
 * or reference it produced — refines it. Types not listed take no task_id (a
 * sub-task uses parent_id).
 */
export const TASK_LINK_RELATION: Partial<Record<EngramType, RelationType>> = {
  decision:  'derived_from',
  note:      'refines',
  rule:      'refines',
  profile:   'refines',
  event:     'refines',
  reference: 'refines',
  log:       'refines',
}

/** v0.15: an open sub-task left behind when its parent was superseded (no cascade). */
export interface OpenSubtask {
  parent_id: string
  id: string
  title: string | null
}

// Event (v0.3) — immutable system event
export type ChangeType =
  | 'deployed' | 'started' | 'completed' | 'failed'
  | 'paused' | 'resumed' | 'created' | 'deleted'

export interface EventProperties {
  occurred_at: string             // ISO timestamp (required)
  change_type: ChangeType         // required
  previous_state?: string
  new_state?: string
  triggered_by?: string
}

// Log (v0.3) — narrative chronological entry (daily note, session log)
export interface LogProperties {
  occurred_at?: string            // optional, default: created_at
}

// Reference (v0.7) — a pointer to something OUTSIDE the brain (URL, doc, paper,
// issue, thread). v0.14 narrows it back to that role: thoughts, syntheses, living
// trackers and working theses that live in the brain are `note` (no typed
// properties — the content is the note).
// v0.8 C7: source_url + source_name moved in from top level (no BaseProperties
// on the context layer; reference is the only context type with typed source fields).
export type ReferenceType = 'analysis' | 'documentation' | 'spec' | 'issue' | 'thread' | 'paper' | 'other'

export interface ReferenceProperties {
  reference_type?: ReferenceType
  source_url?: string             // v0.8: from top level
  source_name?: string            // v0.8: from top level
  accessed_at?: string
  notes?: string
}

// Union type for all properties
export type EngramProperties =
  | DecisionProperties
  | RuleProperties
  | StatusProperties
  | TaskProperties
  | EventProperties
  | LogProperties
  | ReferenceProperties           // v0.7

// === Input types ===

export interface EngramInput {
  content: string
  type: EngramType
  scope: string
  title?: string
  status?: EngramStatus
  significance?: Significance
  properties?: Record<string, unknown>
  // v0.9.1 Cluster 1: ingested_by and namespace removed from user input.
  // The ingested_by column stays in the DB schema (existing legacy brain values as an
  // audit trail) but is no longer set from user input. The namespace column is dropped
  // in Phase 1.4 — until then store() writes an empty string as the NOT NULL default.
  ingestion_method?: IngestionMethod
  session_id?: string
  // v0.12: tag ids (registered slugs) this engram carries. Validated against the
  // tag registry on write — an unknown tag is rejected (create it via the tag
  // registry first). Omit to leave tags untouched; on update, [] clears them.
  tags?: string[]
  // v0.14: subject ids (registered slugs) this engram belongs to. Validated like
  // tags (unknown → reject); a closed subject is accepted (late filing). Omit to
  // leave subjects untouched; on update, [] clears them.
  subjects?: string[]
  // v0.15: create-only — the parent task of a new task. The `part_of` edge is
  // drawn in the same transaction as the insert, so a bad parent fails the whole
  // write instead of leaving an unlinked task. Ignored by update().
  parent_id?: string
  // v0.15: create-only — the task this engram was written in (a decision taken
  // while working on it, its plan as a note). One transaction: the engram, the
  // edge to the task (TASK_LINK_RELATION) and a task entry. Ignored by update().
  task_id?: string
}

// v0.9 Cluster 1: default_namespace removed (multi-caller artifact).
export interface AgentInput {
  id: string                      // user-chosen, e.g. "assistant", "scout-btc"
  name: string
  parent_id?: string
  domains?: string[]
  description?: string
  metadata?: Record<string, unknown>
}

export interface AgentUpdate {
  name?: string
  parent_id?: string | null
  domains?: string[]
  description?: string
  metadata?: Record<string, unknown>
}

export interface RelationInput {
  source_id: string
  target_id: string
  relation: RelationType
  detection_method: DetectionMethod
  strength?: number
  explanation?: string
  metadata?: Record<string, unknown>
}

// === Stored types ===

export interface Engram {
  id: string
  content: string
  type: EngramType
  scope: string
  title: string | null
  status: EngramStatus
  significance: Significance
  properties: Record<string, unknown> | null
  // v0.9.1 Cluster 1: namespace removed from the TS output (column dropped in Phase 1.4).
  // v0.11 team-brains: ingested_by re-exposed as the authorship handle — the server
  // stamps it from the authenticated token (tokens.name = caller) on write. null on
  // legacy/in-process writes; pre-v0.11 rows carry NULL or old legacy brain audit values.
  ingested_by: string | null
  ingestion_method: IngestionMethod | null
  session_id: string | null
  created_at: string
  updated_at: string
  // v0.12: registered tag ids on this engram (always present; [] when none).
  tags: string[]
  // v0.13: workflow/role label ids on this engram (always present; [] when none).
  // Orthogonal to tags; drives surfacing + lifecycle (e.g. `review`). Stamped by
  // the server sweep, not by the write path (MVP).
  labels: string[]
  // v0.14: subject ids this engram belongs to (always present; [] when none).
  subjects: string[]
}

// v0.12: Tags — a registered, per-brain facet vocabulary (parallel to projects).
// `id` is the normalized slug of `name`; membership lives in the engram_tags
// junction (separate from relations). See docs/specs/v0.12-PROPOSAL.md.
export interface TagInput {
  name: string
  description?: string
}

export interface Tag {
  id: string
  name: string
  description: string | null
  created_at: string
}

// v0.13: Labels — a registered, per-brain WORKFLOW/ROLE facet, orthogonal to
// tags. Same shape as Tag (registry + engram_labels junction), but labels mark
// what function an engram serves right now (e.g. `review`) rather than its subject.
// See docs/specs/v0.13-PROPOSAL.md + decision labels-axis-review.
export interface LabelInput {
  name: string
  description?: string
}

export interface Label {
  id: string
  name: string
  description: string | null
  created_at: string
}

// v0.14: Subjects — a registered, per-brain strand with a lifecycle (the "heavy
// facet", docs/specs/v0.14-PROPOSAL.md §B). Same registry + junction shape as
// Tag, plus description + status: a subject can be done (closed), a tag cannot.
export type SubjectStatus = 'active' | 'closed'

export interface SubjectInput {
  name: string
  description?: string
}

export interface SubjectUpdate {
  name?: string
  description?: string | null
  status?: SubjectStatus
}

export interface Subject {
  id: string
  name: string
  description: string | null
  status: SubjectStatus
  // number of engrams in this subject (any engram status)
  engram_count: number
  created_at: string
  updated_at: string
}

export interface Agent {
  id: string
  name: string
  parent_id: string | null
  domains: string[] | null
  description: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// === Users (v0.5) — First-Class Entity ===
// v0.9 Cluster 1: default_namespace removed (multi-caller artifact).

export interface UserInput {
  id: string                      // user-chosen, e.g. "alice"
  name: string
  email?: string
  description?: string
  metadata?: Record<string, unknown>
}

export interface UserUpdate {
  name?: string
  email?: string | null
  description?: string | null
  metadata?: Record<string, unknown>
}

export interface User {
  id: string
  name: string
  email: string | null
  description: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

// === Projects (v0.4) — First-Class Entity ===

export type ProjectStatus = 'active' | 'paused' | 'archived'

export interface ProjectInput {
  id: string                      // user-chosen, e.g. "eml", "acme-app"
  name: string
  status?: ProjectStatus          // default 'active'
  goal?: string
  description?: string
  owner?: string                  // agent/user id, e.g. "alice"
  parent_project?: string         // FK projects.id
  tags?: string[]
  started_at?: string
  ended_at?: string
  metadata?: Record<string, unknown>
}

export interface ProjectUpdate {
  name?: string
  status?: ProjectStatus
  goal?: string
  description?: string
  owner?: string
  parent_project?: string | null  // null allowed to detach from the hierarchy
  tags?: string[]
  started_at?: string
  ended_at?: string
  metadata?: Record<string, unknown>
}

export interface Project {
  id: string
  name: string
  status: ProjectStatus
  goal: string | null
  description: string | null
  owner: string | null
  parent_project: string | null
  tags: string[] | null
  started_at: string | null
  ended_at: string | null
  metadata: Record<string, unknown> | null
  created_at: string
  updated_at: string
}

/**
 * v0.9 Cluster 4: generic BrainState for every scope type (global / project.X /
 * entity.X / agent.X / user.X). Used by the `eml_show(scope)` tool.
 */
export interface ScopedBrainState {
  scope: string
  current_status: Engram[]        // top 3 status engrams in the scope, by updated_at DESC
  open_tasks: Engram[]            // tasks with status in (planned, active), sorted priority DESC, due_date ASC; limit 10
  recent_decisions: Engram[]      // top 5 decisions by created_at DESC (engrams.buildBrainState: recency)
  recent_logs: Engram[]           // recent logs by created_at DESC
  // The two brain-state builders fill these differently (tracked for convergence):
  // engrams.buildBrainState (eml_show path) sets `rules`; projects.getBrainState
  // (project route + CLI) sets `relations`. Both optional so the shared type covers both.
  rules?: Engram[]                // v0.10.5: active rules in scope, name-only in render; limit 15
  relations?: Relation[]          // project brain-state: relations where source/target in scope
  pending_reviews?: Engram[]      // v0.13: active decision/rule/profile carrying the `review` label (staleness flag)
}

/**
 * Project-specific BrainState — wraps ScopedBrainState with a project container.
 */
export interface ProjectBrainState extends ScopedBrainState {
  project: Project
}

export interface Relation {
  id: string
  // v0.9.1 Cluster 1: namespace removed from the TS type. The DB column is dropped in Phase 1.4.
  source_id: string
  target_id: string
  relation: RelationType
  detection_method: DetectionMethod
  strength: number
  explanation: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// === Entities (v0.8 C6) — external parties (people, orgs, assets) ===

export type EntityKind = 'person' | 'org' | 'asset'

export interface EntityInput {
  id: string                      // user-chosen, e.g. "bob", "anthropic", "btc"
  name: string
  kind: EntityKind
  description?: string
}

export interface EntityUpdate {
  name?: string
  kind?: EntityKind
  description?: string | null
}

export interface Entity {
  id: string
  name: string
  kind: EntityKind
  description: string | null
  created_at: string
  updated_at: string
}

// === Query types ===

export interface EngramQuery {
  scope?: string
  type?: EngramType
  title?: string
  status?: EngramStatus
  statuses?: EngramStatus[]       // v0.10.5: status-set (recall uses {active, planned}); takes precedence over `status`
  significance?: Significance
  search?: string                 // FTS5 fulltext
  search_mode?: 'and' | 'or'      // v0.10.5: 'or' = fuzzy (recall), 'and' = precise filter (list, default)
  before?: string                 // created_at < before
  after?: string                  // created_at > after
  // v0.8 C7: domain, min_access_count, decay_alive, source_id, source_type
  // are gone from the top level. Searching properties goes through search/FTS.
  has_relations?: boolean
  // v0.12: filter to engrams carrying this registered tag id (membership join).
  tag?: string
  // v0.13.x: filter to engrams carrying this label id (membership join on
  // engram_labels) — e.g. `review` for the staleness queue the nightly sweep
  // stamps. Same shape as `tag`; labels are the workflow axis, tags the subject.
  label?: string
  // v0.14: filter to engrams belonging to this subject id (membership join on
  // engram_subjects) — cross-scope by nature.
  subject?: string
  // v0.10.9 (audit C0): property-filters pushed into SQL as json_extract so the
  // LIMIT applies AFTER filtering. Previously the CLI filtered post-LIMIT, so a
  // match sorted past the limit was silently dropped (H1). Each maps to a
  // properties key: due_before→$.due_date (<), assignee→$.assignee_id (=),
  // priority→$.priority (=), change_type→$.change_type (=).
  due_before?: string
  assignee?: string
  priority?: string
  change_type?: string
  stage?: string                  // v0.15: $.stage (=)
  limit?: number
  offset?: number
  order_by?: 'created_at' | 'updated_at' | 'significance' | 'score'
  // v0.9.1 Cluster 1: `namespaces` filter removed — 1 user = 1 brain, no more multi-tenancy.
}

export interface EngramWithRelations extends Engram {
  relations: RelationWithTarget[]
  // v0.15: a task's journal, oldest first (absent for other types)
  entries?: TaskEntry[]
}

// v0.10.9: write-time conflict guardrail. A candidate active engram a fresh write
// may duplicate/contradict, surfaced advisory on the store response. `coverage` is
// the fraction of the new write's salient terms present in the candidate (0–1,
// corpus-independent — see findPotentialConflicts); BM25 only ranks. `overlap`
// records the retrieval method (FTS today; embeddings is a separate future track).
export interface ConflictCandidate {
  id: string
  type: EngramType
  title: string | null
  gist: string                    // first 200 chars of the candidate's content
  overlap: 'fts'
  coverage: number                // 0–1, rounded to 2 decimals
}

// v0.10.9: store() return — a stored Engram plus, when non-empty, the advisory
// potential_conflicts. Field is omitted (not []) when there is nothing to surface,
// so an absent field == a clean/silent write.
export type StoredEngram = Engram & {
  potential_conflicts?: ConflictCandidate[]
  // v0.14 Cluster C: `[[targets]]` in content that resolved to no engram — surfaced
  // on the write response (omitted, not [], when everything resolved). Advisory.
  unresolved_links?: string[]
  // v0.15: superseding a parent task does not cascade — its open sub-tasks stay
  // open and are listed here so they can be moved to the successor by hand.
  open_subtasks?: OpenSubtask[]
}

export interface RelationWithTarget extends Relation {
  target_engram?: Partial<Engram>
  source_engram?: Partial<Engram>
}

// === Config ===

export interface EMLConfig {
  // v0.9.1 Cluster 1: namespace stays in EMLConfig as an optional display aid
  // (e.g. brain.name) — no longer used internally for filtering, only as an
  // identifier for logging/debugging. Fully replaced by brainId in v0.9.2+.
  namespace: string
  dbPath?: string
}
