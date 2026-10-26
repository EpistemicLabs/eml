import type Database from 'better-sqlite3'
import { EMLConfig } from './types'
import { initDatabase } from './database'
import { EngramStore } from './engrams'
import { runCommand, type CommandMap, type CommandName } from './commands'
import { AgentStore } from './agents'
import { ProjectStore } from './projects'
import { UserStore } from './users'
import { EntityStore } from './entities'
import { TagStore } from './tags'
import { SubjectStore } from './subjects'
import { type Actor, type Clock, type Env, type IdSource, systemClock, randomId, NO_ACTOR } from './env'

export class EML {
  public engrams!: EngramStore
  public agents!: AgentStore
  public projects!: ProjectStore
  public users!: UserStore
  public entities!: EntityStore
  public tags!: TagStore
  public subjects!: SubjectStore
  private db!: Database.Database
  private ownsConnection: boolean = true
  private clock!: Clock
  private newId!: IdSource

  constructor(config: EMLConfig) {
    this.db = initDatabase(config.dbPath ?? ':memory:', config.clock ?? systemClock)
    this.ownsConnection = true
    this.wireStores(config.namespace, config)
  }

  /**
   * v0.9 (multi-tenant): set up an EML instance on an already open brain DB
   * connection — e.g. a brain DB held by the server-side ConnectionPool.
   *
   * Important: close() is a no-op for EML instances created this way; the pool
   * manages the lifecycle (LRU eviction, idle sweep, shutdown). Without this flag
   * every request boundary would close the shared DB and break all other
   * requests.
   */
  static fromConnection(db: Database.Database, namespace: string, opts: { clock?: Clock, newId?: IdSource } = {}): EML {
    const eml = Object.create(EML.prototype) as EML
    eml.db = db
    eml.ownsConnection = false
    eml.wireStores(namespace, opts)
    return eml
  }

  /**
   * v0.20: the env a write runs in — this brain's clock and id source, and who
   * writes (attribution; default: nobody). Every store write takes one; reads
   * use the same clock (review_due, backlog).
   */
  env(actor: Partial<Actor> = {}): Env {
    return { now: this.clock, newId: this.newId, actor: { ...NO_ACTOR, ...actor } }
  }

  /**
   * v0.20: the one write entry (decision write-command-set). Runs a command —
   * engram.create · engram.update · task.track · learning.add_evidence ·
   * engram.confirm_review · relation.create · object.create · object.update —
   * in one transaction with one time from `env` (default: no actor). A
   * rejection is a CommandError (INVALID · NOT_FOUND · TOPIC_EXISTS · CONFLICT) and
   * writes nothing. Outside the set only engrams.delete writes (decision
   * no-delete-command).
   */
  apply<N extends CommandName>(command: { name: N, input: CommandMap[N][0] }, env: Env = this.env()): CommandMap[N][1] {
    return runCommand({
      eml: this, db: this.db, store: this.engrams,
      projects: this.projects, users: this.users, agents: this.agents, entities: this.entities,
      tags: this.tags, subjects: this.subjects,
    }, command, env)
  }

  /** v0.20: the current time on this brain's clock (ISO-8601 UTC, ms). */
  now(): string {
    return this.clock()
  }

  private wireStores(namespace: string, opts: { clock?: Clock, newId?: IdSource }): void {
    this.clock = opts.clock ?? systemClock
    this.newId = opts.newId ?? randomId
    const env = this.env()
    this.projects = new ProjectStore(this.db, env)
    this.users = new UserStore(this.db)
    this.agents = new AgentStore(this.db)
    this.entities = new EntityStore(this.db)
    this.tags = new TagStore(this.db)
    this.subjects = new SubjectStore(this.db)
    this.engrams = new EngramStore(
      this.db, namespace, this.projects, this.users, this.agents, this.entities,
      this.tags, this.subjects, env,
    )
  }

  close(): void {
    if (this.ownsConnection) this.db.close()
  }
}

export * from './types'
export { significanceWeight, recencyBoost } from './decay'
export { bucketByRelevance, BM25_RELEVANCE_EPS, extractWikilinkTargets } from './engrams'
export {
  extractSalientTerms, termCoverage,
  CONFLICT_TYPES, CONFLICT_COVERAGE_THRESHOLD,
  CONFLICT_CANDIDATE_LIMIT, CONFLICT_MAX, CONFLICT_MIN_SHARED_TERMS,
} from './engrams'
export {
  renderRecallMarkdown, renderBrainStateMarkdown, previewText,
  RECALL_PREVIEW_CHARS, SHOW_PREVIEW_CHARS,
} from './render'
export { validateEngramType, validateNoTemplateLeak, validateFormat, formatProblems, isLegacyFormat, RULE_CONTENT_MAX_CHARS, PROFILE_CONTENT_MAX_CHARS, RULE_TRIGGER_MAX_CHARS } from './validate'
export { ProjectStore } from './projects'
export { TagStore, slugifyTag } from './tags'
export { REVIEWABLE_TYPES, reviewDueSql, reviewDueParams, hydrateReviewDue } from './review-due'
export { SubjectStore, slugifySubject, hydrateEngramSubjects } from './subjects'
export { UserStore } from './users'
export { AgentStore } from './agents'
export { EntityStore } from './entities'
export {
  initControlDatabase,
  CURRENT_CONTROL_SCHEMA_VERSION,
  CURRENT_BRAIN_SCHEMA_VERSION,
  OLDEST_MIGRATABLE_BRAIN_SCHEMA,
} from './control'
export {
  issueToken,
  verifyToken,
  revokeToken,
  touchTokenLastUsed,
  TOKEN_BEARER_PREFIX,
  TOKEN_PREFIX_LENGTH,
  TOKEN_SECRET_LENGTH,
  type IssuedToken,
  type VerifiedToken,
} from './tokens'
export {
  seedDefaultBrain,
  slugifyIdentityName,
  DEFAULT_BRAIN_AGENT_ID,
  DEFAULT_BRAIN_USER_ID,
  type DefaultBrainNames,
} from './default-brain'
export { initDatabase } from './database'
export {
  provisionUser,
  type ProvisionOptions,
  type ProvisionResult,
} from './provisioning'
export {
  runForwardMigrations,
  type ForwardMigrationsReport,
  type BrainMigrationOutcome,
  type RunForwardMigrationsOptions,
  type MigrationReport,
  type MigrationOutcomeKind,
} from './forward-migrations'
export { boot, type BootResult, type BootOptions } from './boot'
export {
  TYPE_FIELDS, ORIGINS, SEED_ORIGIN, BINDINGS, CHANGE_TYPES, RULE_TYPES, APPLIES, TASK_PRIORITIES, STAGES, REMOVED_KEYS, UPGRADE_HINT,
  validateFields, splitFields, unknownFieldsError, type FieldSpec, type FieldKind, type Binding,
} from './fields'
export { listEntries, ENTRY_KINDS, EVIDENCE_SOURCES, EVIDENCE_STANCES, type EntryInput, type EvidenceSource, type EvidenceStance } from './entries'
export { systemClock, randomId, NO_ACTOR, DEFAULT_ENV, beginWrite, addDays, type Actor, type Env, type Clock, type IdSource, type Stamp } from './env'
export { learningState, LEARNING_RIPE_SESSIONS, type LearningState, type LearningStateName } from './learning'
export { readObject, OBJECT_KINDS, type ObjectKind } from './objects'
export {
  CommandError, COMMAND_NAMES, isValidationMessage,
  type Command, type CommandMap, type CommandName, type CommandErrorCode,
  type EngramCreateInput, type EngramCreateResult, type LearningCreateInput, type EngramUpdateInput, type TaskTrackInput,
  type LearningAddEvidenceInput, type EngramConfirmReviewInput, type ObjectCreateInput, type ObjectUpdateInput,
} from './commands'
export { renderLogContent, LEARNING_CONTENT_MAX_CHARS, type EngramPatch, type LearnInput, type LearnResult } from './engrams'
export { projectBlock, projectScopeChain, inheritedRules, type ProjectBlockResult, type ProjectBlockOptions, type ProjectBlockBudgetReport } from './project-block'
export { hygieneCheck, HYGIENE_CHECKS, type HygieneCheck, type HygieneCheckKind, type HygieneDecider, type HygieneCheckResult, type HygieneFinding, type HygieneReport } from './hygiene'
export { ALL_RULES, BEHAVIOR_DEFAULTS, SYSTEM_RULES, type SystemRule } from './system-rules'
