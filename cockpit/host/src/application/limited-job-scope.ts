/**
 * What a limited job's session may do with the schedule tool: look after its own job and nothing
 * else. It may set its next wake-up and its goal, and end the job once the goal is reached. It may
 * not make jobs (they would run with its maker's wider tools), touch other jobs, or change what its
 * job does, whom it hears from or what it may use, since its text comes from strangers.
 */

/** Fields a limited job's session may set on its own job with update. */
const OWN_JOB_FIELDS = new Set(['action', 'job', 'at', 'timezone', 'goal'])
const OWN_JOB_ACTIONS = new Set(['list', 'update', 'finish'])

const REFUSED = 'this job is limited: its session can only set its next wake-up (update with at), its goal, or finish its own job'

/** Why a limited job's session may not send this request, or null when it may. `matches` tells whether `job` names its own job. */
export function limitedJobRefusal(input: Record<string, unknown>, matches: (key: string) => boolean): string | null {
  const action = typeof input.action === 'string' ? input.action : ''
  if (!OWN_JOB_ACTIONS.has(action)) return REFUSED
  if (action === 'list') return null
  if (typeof input.job !== 'string' || !matches(input.job)) return `${REFUSED}; "${String(input.job ?? '')}" is not its job`
  const other = Object.keys(input).filter((key) => input[key] !== undefined && !OWN_JOB_FIELDS.has(key))
  return other.length ? `${REFUSED}; it cannot change ${other.join(', ')}` : null
}
