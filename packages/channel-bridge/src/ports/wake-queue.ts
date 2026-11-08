import type { Wake, WakeEntry } from '../domain/wake'

/** A job's open wake, and the position of its last entry, so a delivery removes only what it carried. */
export interface PendingWake {
  wake: Wake
  upTo: number
}

export interface WakeQueue {
  add(jobId: string, entry: WakeEntry, at: string): Promise<void>
  pending(): Promise<PendingWake[]>
  /** The entries up to this position reached the job; later ones form the next wake. */
  delivered(jobId: string, upTo: number): Promise<void>
  retryLater(jobId: string, attempts: number, retryAt: string): Promise<void>
  /** The entries up to this position could not be delivered; they stay for a person to see. */
  dead(jobId: string, upTo: number): Promise<void>
}
