import { EngramType, ENGRAM_TYPES } from './types'

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
      'Invalid engram: content contains tool-call template syntax (`<parameter name=...`) — ' +
      'this is almost always an XML escaping bug. Closing tags use `</parameter>`, ' +
      'not `</field-name>`. Re-check your tool-call structure.'
    )
  }
}

// v0.19: the per-type field rules moved to fields.ts (TYPE_FIELDS, validateFields);
// the write paths in engrams.ts check the conditional ones (binding with
// task_id, a task's outcome on close, …).

// --- Rule and profile format -------------------------------------------------
//
// Rules and profiles are short at the source, so the boot can carry them whole
// (note rule-delivery-model-draft): a rule's content says only what to do, the
// rationale goes to `why` and playbook or examples to `detail`; a situational
// rule names its situation in `trigger`, which the boot lists in its index. Entries written before the format (legacy) stay valid —
// the boot shows them by title only and counts them in its footer.

export const RULE_CONTENT_MAX_CHARS = 200
export const PROFILE_CONTENT_MAX_CHARS = 400
export const RULE_TRIGGER_MAX_CHARS = 80

/**
 * What keeps a rule or profile from the current format — empty when it fits
 * (and for every other type). One sentence per problem, ready for an error.
 */
export function formatProblems(
  type: string,
  content: string | null | undefined,
  properties: Record<string, unknown> | null | undefined,
): string[] {
  const p = properties ?? {}
  const len = (content ?? '').length
  const out: string[] = []
  if (type === 'rule') {
    if (len > RULE_CONTENT_MAX_CHARS) {
      out.push(
        `a rule's content is at most ${RULE_CONTENT_MAX_CHARS} characters (got ${len}) — state only what to do. ` +
        'Put the rationale in why and playbook or examples in detail.',
      )
    }
    if (p.applies === 'situational') {
      const trigger = p.trigger
      if (typeof trigger !== 'string' || trigger.trim() === '') {
        out.push(
          'a situational rule needs trigger — the situation it applies in, ' +
          `at most ${RULE_TRIGGER_MAX_CHARS} characters. Don't repeat it in content.`,
        )
      } else if (trigger.length > RULE_TRIGGER_MAX_CHARS) {
        out.push(`trigger is at most ${RULE_TRIGGER_MAX_CHARS} characters (got ${trigger.length}).`)
      }
    }
  } else if (type === 'profile') {
    if (len > PROFILE_CONTENT_MAX_CHARS) {
      out.push(
        `a profile's content is at most ${PROFILE_CONTENT_MAX_CHARS} characters (got ${len}) — keep the core facts; ` +
        'put the rest in detail or a separate profile.',
      )
    }
  }
  return out
}

/** True when a rule or profile does not fit the current format (a legacy entry). */
export function isLegacyFormat(
  type: string,
  content: string | null | undefined,
  properties: Record<string, unknown> | null | undefined,
): boolean {
  return formatProblems(type, content, properties).length > 0
}

/**
 * Enforce the rule/profile format on a write. Callers run it on create and on
 * an update that changes content, trigger, applies or type; status-only and
 * review changes skip it, so legacy entries stay patchable (like legacy
 * decisions, validateProperties create=false).
 */
export function validateFormat(
  type: string,
  content: string | null | undefined,
  properties: Record<string, unknown> | null | undefined,
): void {
  const problems = formatProblems(type, content, properties)
  if (problems.length === 0) return
  const sentences = problems.map((m, i) => i === 0 ? m : m[0].toUpperCase() + m.slice(1))
  throw new Error(`Invalid engram: ${sentences.join(' ')}`)
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
      // v0.19: projects and entities are objects (eml_create_object); users and agents come from setup / the cockpit.
      const hint = label === 'project' || label === 'entity'
        ? `Create it first with eml_create_object(object=${label}, name=…, id=${id}${label === 'entity' ? ', kind=person|org|asset' : ''}).`
        : `Users and agents are set up by the cockpit, not by a write.`
      throw new Error(`Scope "${scope}" references unknown ${label} "${id}". ${hint}`)
    }
    return
  }
  // global → no existence check (by design — reserved shared tenant)
}
