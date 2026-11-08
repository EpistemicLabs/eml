import type { Cockpit, WakeOutcome, WakeRequest } from '../../ports/cockpit'

/**
 * Records every wake. A job it was set up with is delivered unless another outcome is set for it;
 * any other job is refused, as the cockpit refuses a job it does not know.
 */
export class RecordingCockpit implements Cockpit {
  readonly requests: WakeRequest[] = []
  private readonly outcomes = new Map<string, WakeOutcome>()

  constructor(jobIds: string[]) {
    for (const jobId of jobIds) this.outcomes.set(jobId, 'delivered')
  }

  answer(jobId: string, outcome: WakeOutcome): void {
    this.outcomes.set(jobId, outcome)
  }

  async wakeJob(request: WakeRequest): Promise<WakeOutcome> {
    this.requests.push(request)
    return this.outcomes.get(request.jobId) ?? 'refused'
  }
}
