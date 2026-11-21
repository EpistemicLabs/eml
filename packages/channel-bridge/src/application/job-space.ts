import type { ChannelAccount } from '../ports/channel'
import type { JobDirectory } from '../ports/job-directory'

/**
 * The space of the job a draft belongs to, for its wake: the account's only space, or else the one
 * the cockpit names for the job. Without an answer it is the account's first space; a wake the
 * cockpit refuses for the wrong space is kept as dead, never sent elsewhere.
 */
export async function jobSpace(jobs: JobDirectory | undefined, jobId: string, account: ChannelAccount): Promise<string> {
  if (account.spaces.length === 1 || !jobs) return account.spaces[0]
  const answer = await jobs.route(jobId)
  return answer.kind === 'route' && answer.route && account.spaces.includes(answer.route.space) ? answer.route.space : account.spaces[0]
}
