import { CommandError, inputObject, requireText, type CommandModule } from './types'

// --- provenance.restamp (v0.21, decision cockpit-identity-agent-brain) ---------
//
// Before the agent brain, a cockpit stamped the agent's name as the handle: the
// token was named after the agent, so ingested_by said "motti" where the person
// was dominik and the agent motti. This command sets the record straight for
// one such handle: every engram and entry written as from_handle with no agent
// becomes to_handle via agent. Rows that already name an agent, and rows of
// other handles, stay. It is an op like any write, so a rebuild replays it;
// rev does not move — provenance is attribution, not content.
//
// A shared brain refuses it: a member could otherwise seal it as an op and
// rewrite another member's authorship on every replica. The restamp is for a
// private brain written before the agent brain (the cockpit's upgrade).

export interface ProvenanceRestampInput {
  from_handle: string
  to_handle: string
  agent: string
}

export interface ProvenanceRestampResult {
  engrams: number
  entries: number
}

/** A handle or an agent as provenance names it (apply-op.ts AGENT, protocol §6). */
const HANDLE = /^[a-z0-9_-]{1,63}$/

export const provenanceRestamp: CommandModule<ProvenanceRestampInput, ProvenanceRestampResult> = {
  name: 'provenance.restamp',
  validate(input) {
    const o = inputObject('provenance.restamp', input)
    const unknown = Object.keys(o).filter(k => !['from_handle', 'to_handle', 'agent'].includes(k) && o[k] !== undefined)
    if (unknown.length > 0) throw new CommandError('INVALID', `Invalid command: unknown field${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} — provenance.restamp takes from_handle, to_handle, agent.`)
    const out: Record<string, string> = {}
    for (const field of ['from_handle', 'to_handle', 'agent'] as const) {
      const v = requireText(o, field, `Invalid command: provenance.restamp needs ${field}.`)
      if (!HANDLE.test(v)) throw new CommandError('INVALID', `Invalid command: ${field} is 1–63 characters of a-z, 0-9, _ and -.`)
      out[field] = v
    }
    if (out.from_handle === out.to_handle) throw new CommandError('INVALID', 'Invalid command: from_handle and to_handle must differ.')
    return out as unknown as ProvenanceRestampInput
  },
  apply(ctx, input) {
    if (ctx.eml.teamBrain() !== null) throw new CommandError('INVALID', 'Invalid command: a shared brain takes no provenance.restamp — authorship in a team brain is never rewritten.')
    const engrams = ctx.db.prepare('UPDATE engrams SET ingested_by = ?, agent = ? WHERE ingested_by = ? AND agent IS NULL')
      .run(input.to_handle, input.agent, input.from_handle).changes
    const entries = ctx.db.prepare('UPDATE entries SET author = ?, agent = ? WHERE author = ? AND agent IS NULL')
      .run(input.to_handle, input.agent, input.from_handle).changes
    return { engrams, entries }
  },
}
