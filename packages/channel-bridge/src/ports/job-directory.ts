import type { JobRoute } from '../domain/routing'

/** The cockpit owns the jobs; the bridge asks it. */
export interface JobDirectory {
  /** The open jobs of a space that listen on a channel. */
  routesInSpace(space: string): Promise<JobRoute[]>
  route(jobId: string): Promise<JobRoute | null>
}
