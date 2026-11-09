/**
 * The brain routes the cockpit page calls through the host's proxies
 * (http.ts proxyBrain for /api/brain/*, agents-api.ts for an agent brain's
 * read). The proxies add the brain token, so they pass these and nothing
 * else: a route the page does not use — deleting a brain, a team's invites, a
 * project's move — reaches the server only through the host's own routes and
 * their safeguards (backup, typed name, fingerprint, registry). An id is a
 * single segment of letters, digits, - and _ (core's object and engram ids),
 * so `..` or an encoded slash never matches.
 *
 * A new brain call in the page goes into this table with it
 * (tests/page-brain-routes.test.ts reads the page's brainGet/brainPost calls).
 */

const ID = '[A-Za-z0-9_-]+'

type Route = readonly [method: 'GET' | 'POST', path: RegExp]

const route = (method: 'GET' | 'POST', path: string): Route => [method, new RegExp(`^${path.replaceAll(':id', ID)}$`)]

/** /api/brain/* — the Brain views, the review queue, the project wizard (cockpit/frontend/src/lib/queries.ts, ProjectCreationWizard.tsx). */
export const SPACE_BRAIN_ROUTES: readonly Route[] = [
  route('GET', '/list'),
  route('GET', '/projects'),
  route('GET', '/stats'),
  route('GET', '/subjects'),
  route('GET', '/engram/:id'),
  route('GET', '/project/:id'),
  route('GET', '/project/:id/engrams'),
  route('GET', '/project/:id/relations'),
  route('POST', '/engram/task'),
  route('POST', '/recall'),
  route('POST', '/relate'),
  route('POST', '/update'),
  route('POST', '/engram/:id/confirm-review'),
  route('POST', '/task/:id/track'),
  route('POST', '/object/project'),
]

/** /api/agents/:id/brain/* — Settings › Agent reads the agent's brain (AgentTab.tsx). */
export const AGENT_BRAIN_ROUTES: readonly Route[] = [
  route('GET', '/list'),
]

/** Whether `method` on the brain-relative `path` (its query left off) is one of `routes`. */
export function isPageRoute(routes: readonly Route[], method: string, path: string): boolean {
  return routes.some(([m, p]) => m === method && p.test(path))
}

/** The proxies' refusal of any other route. */
export const NOT_PASSED = { code: 'NOT_PASSED', message: 'The cockpit page does not use this brain route.' }
