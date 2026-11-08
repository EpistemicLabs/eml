import type { Channel } from '../domain/address'
import type { JobRoute } from '../domain/routing'

/** The cockpit could not answer now; asking again later may help. */
export interface DirectoryUnavailable {
  kind: 'unavailable'
  reason: 'no_token' | 'cockpit_unreachable' | 'bad_status' | 'bad_answer'
  retryable: true
}

export type RoutesAnswer = { kind: 'routes'; routes: JobRoute[] } | DirectoryUnavailable
export type RouteAnswer = { kind: 'route'; route: JobRoute | null } | DirectoryUnavailable

/** The cockpit owns the jobs; the bridge asks it. */
export interface JobDirectory {
  /** The open jobs of a space that listen on a channel. */
  routesInSpace(space: string, channel: Channel): Promise<RoutesAnswer>
  /** A job by id, or null when no open job has it. */
  route(jobId: string): Promise<RouteAnswer>
}
