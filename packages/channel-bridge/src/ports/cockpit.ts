/**
 * delivered  the job's session has it
 * retry      not now (busy, no room, cockpit away); the same request may be sent again
 * refused    the job does not take wakes (ended, unknown); retrying cannot help
 */
export type WakeOutcome = 'delivered' | 'retry' | 'refused'

export interface WakeRequest {
  jobId: string
  /** The job's space: the cockpit takes requests for a space only with that space's token. */
  space: string
  text: string
  /** The same key twice is the same wake. */
  idempotencyKey: string
}

export interface Cockpit {
  wakeJob(request: WakeRequest): Promise<WakeOutcome>
}
