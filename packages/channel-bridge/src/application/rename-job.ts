import type { JobIds, JobRenamed } from '../ports/job-ids'

export interface RenameJobDeps {
  jobIds: JobIds
}

export type RenameJobResult =
  | ({ kind: 'renamed'; from: string; to: string } & JobRenamed)
  | { kind: 'refused'; reason: 'same_id'; retryable: false }

/**
 * The cockpit gave a job a new id: what the bridge holds for it follows, so its messages, its open wake and its
 * drafts are found under the id the cockpit asks with from now on. Safe to ask again: a second rename finds
 * nothing left to move. Rows the new id already held are kept, and the answer names them.
 */
export async function renameJob(deps: RenameJobDeps, input: { from: string; to: string }): Promise<RenameJobResult> {
  if (input.from === input.to) return { kind: 'refused', reason: 'same_id', retryable: false }
  return { kind: 'renamed', from: input.from, to: input.to, ...(await deps.jobIds.rename(input.from, input.to)) }
}
