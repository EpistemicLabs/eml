import type { JobRoute } from '../../domain/routing'
import type { DirectoryUnavailable, JobDirectory, RouteAnswer, RoutesAnswer } from '../../ports/job-directory'

export class MemoryJobDirectory implements JobDirectory {
  private down: DirectoryUnavailable | null = null

  constructor(private routes: JobRoute[] = []) {}

  set(routes: JobRoute[]): void {
    this.routes = routes
  }

  unavailable(reason: DirectoryUnavailable['reason']): void {
    this.down = { kind: 'unavailable', reason, retryable: true }
  }

  available(): void {
    this.down = null
  }

  async routesInSpace(space: string): Promise<RoutesAnswer> {
    if (this.down) return this.down
    return { kind: 'routes', routes: this.routes.filter((route) => route.space === space) }
  }

  async route(jobId: string): Promise<RouteAnswer> {
    if (this.down) return this.down
    return { kind: 'route', route: this.routes.find((route) => route.jobId === jobId) ?? null }
  }
}
