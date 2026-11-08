import { describe, it, expect } from 'vitest'
import type { JobDirectory } from '../../src/ports/job-directory'
import type { JobRoute } from '../../src/domain/routing'

/** The jobs every JobDirectory under test is set up with. */
export const contractRoutes: JobRoute[] = [
  { jobId: 'job-a', space: 'support', matches: [{ kind: 'domain', domain: 'customer.example' }], reply: { mail: 'draft' }, paused: false },
  { jobId: 'job-b', space: 'errands', matches: [{ kind: 'address', address: 'shop@shop.example' }], reply: { mail: 'send' }, paused: true },
]

/** What every JobDirectory must do, given one set up with contractRoutes. */
export function jobDirectoryContract(name: string, make: () => JobDirectory): void {
  describe(`JobDirectory contract: ${name}`, () => {
    it('lists the jobs of one space only', async () => {
      expect(await make().routesInSpace('support', 'mail')).toEqual({ kind: 'routes', routes: [contractRoutes[0]] })
    })

    it('finds a job by id in any space, and null for an unknown one', async () => {
      expect(await make().route('job-b')).toEqual({ kind: 'route', route: contractRoutes[1] })
      expect(await make().route('job-none')).toEqual({ kind: 'route', route: null })
    })
  })
}
