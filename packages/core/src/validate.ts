import { EngramType, EngramStatus, ENGRAM_TYPES, TASK_STAGES, TASK_OUTCOME_STATUSES } from './types'

/**
 * An engram type must be one of ENGRAM_TYPES — a readable 400 instead of the
 * DB CHECK's error.
 */
export function validateEngramType(type: unknown): asserts type is EngramType {
  if ((ENGRAM_TYPES as readonly unknown[]).includes(type)) return
  throw new Error(`Invalid engram: unknown type "${String(type)}". Valid types: ${ENGRAM_TYPES.join(', ')}.`)
}

/**
 * Detects tool-call template syntax leaking into engram content. A common
 * agent bug: an XML closing tag is mistyped (`</content>` instead of
 * `</parameter>`), so the remaining parameter wrappers end up as literal
 * text inside `content`. We reject those writes with a clear hint instead
 * of silently storing garbage.
 *
 * If documenting tool-call XML is intentional, wrap it in a code fence or
 * escape the `<` characters.
 */
export function validateNoTemplateLeak(content: string | undefined | null): void {
  if (!content) return
  if (/<parameter\s+name=/i.test(content)) {
    throw new Error(
      'content contains tool-call template syntax (`<parameter name=...`) — ' +
      'this is almost always an XML escaping bug. Closing tags use `</parameter>`, ' +
      'not `</field-name>`. Re-check your tool-call structure.'
    )
  }
}

/**
 * Validate required properties for an engram type.
 * Throws on missing required fields.
 *
 * v0.15: `opts.create` gates the requirements that only hold for NEW engrams
 * (decision: rationale + ≥ 1 alternative), so legacy data stays patchable and
 * supersedable. `opts.prevStatus` is the stored status on update, for checks that
 * fire on a status TRANSITION only. Errors from these checks start with
 * `Invalid engram:` (one prefix for the server's 400 mapping).
 */
export function validateProperties(
  type: EngramType,
  properties: Record<string, unknown> | null | undefined,
  status?: EngramStatus,
  opts: { create: boolean; prevStatus?: EngramStatus } = { create: false }
): void {
  const p = properties ?? {}
  const errors: string[] = []

  function require(field: string) {
    if (p[field] === undefined || p[field] === null) {
      errors.push(field)
    }
  }

  switch (type) {
    case 'decision': {
      // v0.15: a decision is a choice between real alternatives, with a rationale.
      // Create only — legacy decisions without them stay patchable/supersedable.
      if (!opts.create) break
      const missing: string[] = []
      const alts = p.alternatives
      if (!Array.isArray(alts) || !alts.some(a => typeof a === 'string' && a.trim() !== '')) {
        missing.push('a decision needs at least one alternative that was considered and rejected.')
      }
      if (typeof p.rationale !== 'string' || p.rationale.trim() === '') {
        missing.push('a decision needs a rationale — why this option won.')
      }
      if (missing.length > 0) {
        const sentences = missing.map((m, i) => i === 0 ? m : m[0].toUpperCase() + m.slice(1))
        throw new Error(`Invalid engram: ${sentences.join(' ')}`)
      }
      break
    }

    case 'rule':
      // v0.10.8: `applies` (always|situational) replaces `enforcement`. Required +
      // enum-validated here so direct library/CLI/SDK writes can't inject off-schema
      // values that bypass the MCP gate (the gap that let `always`/`must` in pre-0.10.8).
      require('applies')
      if (p.applies !== undefined && p.applies !== null
        && p.applies !== 'always' && p.applies !== 'situational') {
        errors.push(`applies (must be 'always' or 'situational', got '${String(p.applies)}')`)
      }
      break

    case 'profile':
      // v0.5: ProfileType removed entirely. Core identity data lives in the
      // users/agents tables; profile engrams no longer have required properties.
      break

    case 'status':
      // v0.8 C7: status_type/subject_state/phase gone; state required.
      require('state')
      break

    case 'task': {
      // v0.15: stage is an optional enum (a property, so the DB does not guard it).
      if (p.stage !== undefined && p.stage !== null && !(TASK_STAGES as readonly unknown[]).includes(p.stage)) {
        throw new Error(`Invalid engram: stage must be one of ${TASK_STAGES.join(', ')}.`)
      }
      // v0.15: closing a task with a result needs an outcome — on the TRANSITION
      // into resolved/invalidated only (a create counts as one). A legacy closed
      // task without outcome stays patchable.
      const entering = status !== undefined && TASK_OUTCOME_STATUSES.includes(status)
        && (opts.create || opts.prevStatus !== status)
      if (entering && (typeof p.outcome !== 'string' || p.outcome.trim() === '')) {
        throw new Error('Invalid engram: closing a task (resolved/invalidated) needs an outcome.')
      }
      break
    }

    case 'event':
      require('occurred_at')
      require('change_type')
      break

    case 'log':
      // No required fields — log can minimally have only content
      break

    case 'reference':
      // v0.7: No required fields — substance lives in content + title +
      // source_url/source_name (core engram columns). ReferenceProperties
      // (reference_type, accessed_at, notes) are all optional.
      break

    case 'note':
      // v0.14: No typed properties — a note is its content.
      break
  }

  if (errors.length > 0) {
    throw new Error(`Missing required properties for ${type}: ${errors.join(', ')}`)
  }
}

// v0.9.1 Cluster 1: validateSourceType removed — source_id/source_type were
// dropped from the engram schema (1 user = 1 brain, no multi-caller).

// ============================================================
// v0.8 C3: scope validation hardening
// ============================================================

// v0.8 C2: entity scope rename — external.<x> is gone, everything external
// now goes through entity.<x> (with a hard existence check against the entities table).
const VALID_SCOPE_PATTERNS: ReadonlyArray<RegExp> = [
  /^global$/,
  /^project\.[a-z0-9_-]+$/i,
  /^agent\.[a-z0-9_-]+$/i,
  /^user\.[a-z0-9_-]+$/i,
  /^entity\.[a-z0-9_-]+$/i,
]

/**
 * v0.8 C3: pattern validation.
 * Throws if scope does not match one of the allowed patterns.
 * (e.g. 'project' without an ID, or 'foo.bar' with an unknown prefix.)
 */
export function validateScopePattern(scope: string): void {
  if (!VALID_SCOPE_PATTERNS.some(re => re.test(scope))) {
    throw new Error(
      `Invalid scope "${scope}". Must match one of: ` +
      `global, project.<id>, agent.<id>, user.<id>, entity.<id>.`
    )
  }
}

/**
 * v0.8 C3: hard existence check.
 * Throws if scope='<type>.X' but X is not in the corresponding table.
 * Pre-check via stores.has(): false allowed → no existence check (for tests
 * without ProjectStore etc. that instantiate EngramStore directly).
 *
 * scope='global' is NEVER existence-validated (reserved shared tenant).
 * v0.8 C2: external.<x> moved to entity.<x> with a hard existence check.
 */
export interface ScopeStores {
  projects?: { exists(id: string): boolean }
  users?: { exists(id: string): boolean }
  agents?: { exists(id: string): boolean }
  entities?: { exists(id: string): boolean }
}

export function validateScopeExists(scope: string, stores: ScopeStores): void {
  const checks: Array<[string, keyof ScopeStores, string]> = [
    ['project.',  'projects', 'project'],
    ['user.',     'users',    'user'],
    ['agent.',    'agents',   'agent'],
    ['entity.',   'entities', 'entity'],
  ]
  for (const [prefix, storeKey, label] of checks) {
    if (!scope.startsWith(prefix)) continue
    const store = stores[storeKey]
    if (!store) return  // Store not wired → no check (test DI gap)
    const id = scope.slice(prefix.length)
    if (!id) {
      throw new Error(`Invalid scope "${scope}": empty ${label} id after "${prefix}".`)
    }
    if (!store.exists(id)) {
      throw new Error(
        `Scope "${scope}" references unknown ${label} "${id}". ` +
        `Create the ${label} via POST /${label}.`
      )
    }
    return
  }
  // global → no existence check (by design — reserved shared tenant)
}
