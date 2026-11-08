import { describe, it, expect } from 'vitest'
import type { Cockpit } from '../../src/ports/cockpit'

/**
 * What every Cockpit must do, given one set up with two jobs: job-a takes wakes, job-busy has no
 * room right now. Any other job is unknown.
 */
export function cockpitContract(name: string, make: () => Cockpit): void {
  describe(`Cockpit contract: ${name}`, () => {
    const wake = (jobId: string) => make().wakeJob({ jobId, space: 'support', text: '1 new message', idempotencyKey: `${jobId}:1` })

    it('delivers a wake to a job that takes it', async () => {
      expect(await wake('job-a')).toBe('delivered')
    })

    it('asks to retry when the job has no room', async () => {
      expect(await wake('job-busy')).toBe('retry')
    })

    it('refuses a wake for an unknown job', async () => {
      expect(await wake('job-none')).toBe('refused')
    })
  })
}
