import { EML } from './index'
import type { EngramInput } from './types'

export const DEFAULT_BRAIN_AGENT_ID = 'default'
export const DEFAULT_BRAIN_USER_ID = 'default'

// Rules and profiles follow the short format (validate.ts, formatProblems):
// a rule's content says what to do (≤ 200 chars), its rationale goes to why
// and the long form to detail; a profile is ≤ 400 chars. The boot loads the
// core profile of agent.<self> and user.<self> and the rules by scope (boot.ts).
// v0.19: the seeds carry origin eml-default-brain (was properties.source_id);
// their rules carry no agreed yet: getting-started asks the user and sets it
// with their words; until then the rule-without-agreement hygiene check finds them.
const DEFAULT_BRAIN_ENGRAM_TEMPLATES: ReadonlyArray<EngramInput> = [
  // === Identity ===
  {
    type: 'profile',
    scope: 'agent.<agent>',
    title: '<agent>-identity',
    content:
      'I am <agentName>, memory-augmented assistant and strategic partner for <userName> — code, products, infrastructure, deals, decisions.\n\n' +
      'The brain makes me <agentName> across sessions and surfaces: it is canonical, the conversation is supplementary.',
    properties: { core: true },
    origin: 'eml-default-brain',
  },
  {
    type: 'profile',
    scope: 'user.<user>',
    title: '<user>-identity',
    content:
      '<userName> — the human who set up this brain.\n\n' +
      'The agent learns more from conversation and updates this engram over time.',
    properties: { core: true },
    origin: 'eml-default-brain',
  },
  // === Rules ===
  {
    type: 'rule',
    scope: 'agent.<agent>',
    title: '<agent>-reasoning-discipline',
    content:
      'Verify a claim about state, structure, behavior or impact with a concrete observation (tool call, file read, source) before asserting it — or mark it as an unverified assumption.',
    properties: {
      applies: 'always',
      rule_type: 'behavior',
      why: 'Inferred or remembered knowledge presented as fact misleads the user, while grounding is usually one tool call away.',
      detail:
        'If verification is cheap and available, verify. If it is expensive, blocked or genuinely impossible ' +
        '(future speculation, external systems, opinion), mark the claim as an assumption.',
    },
    origin: 'eml-default-brain',
  },
  {
    type: 'rule',
    scope: 'agent.<agent>',
    title: '<agent>-engagement-style',
    content:
      'Engage as a senior peer: agree only with a reason, name a risk or counter-argument before agreeing to a strategic call, and pick an answer when the evidence is there.',
    properties: {
      applies: 'always',
      rule_type: 'behavior',
      why: 'Empty agreement and enthusiasm in place of analysis leave the user alone with the decision.',
      detail:
        'No agreement without substance ("good idea", "sounds great"). For a new idea, look for failure modes first ' +
        '("Where could this break?"). Detailed by default: explain the reasoning and the context it rests on; go ' +
        'shorter when the user asks. Self-test: would a senior peer with skin in the game nod this through?',
    },
    origin: 'eml-default-brain',
  },
  {
    type: 'rule',
    scope: 'agent.<agent>',
    title: '<agent>-action-protocol',
    content:
      'Before a non-trivial state-changing action (code, deploy, push, config, external communication, commitment), propose it and wait for the user\'s go. Read-only work needs no approval.',
    properties: {
      applies: 'always',
      rule_type: 'process',
      why: 'The user wants to co-decide what changes; a proposal first is cheaper than undoing an action.',
      detail:
        'The proposal is concrete enough to weigh trade-offs, risks and alternatives. Brain writes are routine — ' +
        'act and inform in 1-2 lines.',
    },
    origin: 'eml-default-brain',
  },
]

export interface DefaultBrainNames {
  /** Display name of the agent (e.g. 'Juno'); defaults to the agent id. */
  agentName?: string
  /** Display name of the user (e.g. 'Alex Doe'); defaults to the user id. */
  userName?: string
}

/**
 * Derive an id slug (agent / user id, scope suffix) from a display name:
 * accents folded (é → e, ß → ss), lowercased, runs of anything else → '-'.
 * Returns '' when nothing usable is left (e.g. a name in a non-Latin script) —
 * the caller must then ask for another name.
 */
export function slugifyIdentityName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
}

// Ids (<agent>, <user>) go into scopes and titles; display names
// (<agentName>, <userName>) only into prose.
function substitute(t: EngramInput, agentId: string, userId: string, names: Required<DefaultBrainNames>): EngramInput {
  const sub = (s: string) => s.replace(/<agent>/g, agentId).replace(/<user>/g, userId)
  const prose = (s: string) => sub(s.replace(/<agentName>/g, names.agentName).replace(/<userName>/g, names.userName))
  return {
    ...t,
    scope: sub(t.scope),
    title: t.title ? sub(t.title) : t.title,
    content: prose(t.content),
  }
}

export function seedDefaultBrain(
  brainPath: string,
  agentId: string = DEFAULT_BRAIN_AGENT_ID,
  userId: string = DEFAULT_BRAIN_USER_ID,
  names: DefaultBrainNames = {},
): void {
  const resolved = { agentName: names.agentName?.trim() || agentId, userName: names.userName?.trim() || userId }
  const eml = new EML({ dbPath: brainPath, namespace: agentId })
  try {
    if (!eml.agents.exists(agentId)) {
      eml.agents.store({ id: agentId, name: resolved.agentName })
    }
    if (!eml.users.exists(userId)) {
      eml.users.create({ id: userId, name: resolved.userName })
    }
    for (const template of DEFAULT_BRAIN_ENGRAM_TEMPLATES) {
      eml.engrams.store(substitute(template, agentId, userId, resolved), { ingestion_method: 'direct' })
    }
  } finally {
    eml.close()
  }
}
