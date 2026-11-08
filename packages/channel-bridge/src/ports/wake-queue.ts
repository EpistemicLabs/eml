import type { PendingWake, WakeEntry, WakeOwner } from '../domain/wake'

export type { PendingWake }

export interface WakeQueue {
  /** Adds an entry; one the job's open wake already holds is not added twice. */
  add(owner: WakeOwner, entry: WakeEntry, at: string): Promise<void>
  pending(): Promise<PendingWake[]>
  /** The entries up to this position reached the job; later ones form the next wake. */
  delivered(jobId: string, upTo: number): Promise<void>
  retryLater(jobId: string, attempts: number, retryAt: string): Promise<void>
  /** The entries up to this position could not be delivered; they stay for a person to see. */
  dead(jobId: string, upTo: number): Promise<void>
}
