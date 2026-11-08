import type { Cockpit, WakeOutcome, WakeRequest } from '../../ports/cockpit'

/** Records every wake and answers with the outcome set for the job, 'delivered' by default. */
export class RecordingCockpit implements Cockpit {
  readonly requests: WakeRequest[] = []
  private readonly outcomes = new Map<string, WakeOutcome>()

  answer(jobId: string, outcome: WakeOutcome): void {
    this.outcomes.set(jobId, outcome)
  }

  async wakeJob(request: WakeRequest): Promise<WakeOutcome> {
    this.requests.push(request)
    return this.outcomes.get(request.jobId) ?? 'delivered'
  }
}
