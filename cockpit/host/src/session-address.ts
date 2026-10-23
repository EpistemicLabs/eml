import { brainIdFromProjectId } from './project-registry.js'

/**
 * A session's address among agent sessions: the name Claude Code's
 * cross-session messaging (ListAgents / SendMessage) knows it by, passed as
 * `--name` at every launch. Derived from the cockpit's session id, so it never
 * changes while the session lives and maps back to the ledger; the project
 * prefix only helps an agent reading a session list. Separate from the title
 * the user sees in the sidebar, which may change at any time.
 */
export function sessionAddress(sessionId: string, projectId: string | null): string {
  const brainId = projectId ? brainIdFromProjectId(projectId) : null
  const prefix = (brainId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'session'
  return `${prefix}-${sessionId.replace(/-/g, '').slice(0, 8)}`
}
