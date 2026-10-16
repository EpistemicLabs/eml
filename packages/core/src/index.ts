import type Database from 'better-sqlite3'
import { EMLConfig } from './types'
import { initDatabase } from './database'
import { EngramStore } from './engrams'
import { AgentStore } from './agents'
import { ProjectStore } from './projects'
import { UserStore } from './users'
import { EntityStore } from './entities'
import { TagStore } from './tags'
import { LabelStore } from './labels'
import { SubjectStore } from './subjects'

export class EML {
  public engrams!: EngramStore
  public agents!: AgentStore
  public projects!: ProjectStore
  public users!: UserStore
  public entities!: EntityStore
  public tags!: TagStore
  public labels!: LabelStore
  public subjects!: SubjectStore
  private db!: Database.Database
  private ownsConnection: boolean = true

  constructor(config: EMLConfig) {
    this.db = initDatabase(config.dbPath ?? ':memory:')
    this.ownsConnection = true
    this.wireStores(config.namespace)
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
  static fromConnection(db: Database.Database, namespace: string): EML {
    const eml = Object.create(EML.prototype) as EML
    eml.db = db
    eml.ownsConnection = false
    eml.wireStores(namespace)
    return eml
  }

  private wireStores(namespace: string): void {
    this.projects = new ProjectStore(this.db)
    this.users = new UserStore(this.db)
    this.agents = new AgentStore(this.db)
    this.entities = new EntityStore(this.db)
    this.tags = new TagStore(this.db)
    this.labels = new LabelStore(this.db)
    this.subjects = new SubjectStore(this.db)
    this.engrams = new EngramStore(
      this.db, namespace, this.projects, this.users, this.agents, this.entities,
      this.tags, this.subjects,
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
  CONFLICT_CANDIDATE_LIMIT, CONFLICT_MAX,
  REVIEW_LABEL, REVIEWABLE_TYPES,
} from './engrams'
export {
  renderRecallMarkdown, renderBrainStateMarkdown, previewText,
  RECALL_PREVIEW_CHARS, SHOW_PREVIEW_CHARS,
} from './render'
export { validateEngramType, validateProperties, validateNoTemplateLeak, validateFormat, formatProblems, isLegacyFormat, RULE_CONTENT_MAX_CHARS, PROFILE_CONTENT_MAX_CHARS, RULE_TRIGGER_MAX_CHARS } from './validate'
export { ProjectStore } from './projects'
export { TagStore, slugifyTag } from './tags'
export { LabelStore, slugifyLabel, hydrateEngramLabels } from './labels'
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
export { ALL_RULES, BEHAVIOR_DEFAULTS, SYSTEM_RULES, type SystemRule } from './system-rules'
