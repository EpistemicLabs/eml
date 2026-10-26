import { validateScopePattern, validateScopeExists } from '../validate'
import type { WriteContext } from './context'

/**
 * v0.8 C3: hard scope validation (was: soft warning).
 * Pattern check + existence check via validate.ts.
 * Throws on an invalid pattern or an unknown project/user/agent/entity.
 * scope='global' gets no existence check (see validateScopeExists).
 */
export function validateScope(ctx: WriteContext, scope: string): void {
  validateScopePattern(scope)
  validateScopeExists(scope, {
    projects: ctx.projects,
    users:    ctx.users,
    agents:   ctx.agents,
    entities: ctx.entities,
  })
}
