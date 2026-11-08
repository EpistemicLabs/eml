import type { JobRoute } from '../../domain/routing'
import type { JobDirectory } from '../../ports/job-directory'

export class MemoryJobDirectory implements JobDirectory {
  constructor(private routes: JobRoute[] = []) {}

  set(routes: JobRoute[]): void {
    this.routes = routes
  }

  async routesInSpace(space: string): Promise<JobRoute[]> {
    return this.routes.filter((route) => route.space === space)
  }

  async route(jobId: string): Promise<JobRoute | null> {
    return this.routes.find((route) => route.jobId === jobId) ?? null
  }
}
