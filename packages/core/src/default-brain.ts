import { EML } from './index'
import type { EngramInput } from './types'

export const DEFAULT_BRAIN_AGENT_ID = 'default'
export const DEFAULT_BRAIN_USER_ID = 'default'

const DEFAULT_BRAIN_ENGRAM_TEMPLATES: ReadonlyArray<EngramInput> = [
  // === Identity ===
  {
    type: 'profile',
    scope: 'agent.<agent>',
    title: '<agent>-identity',
    significance: 'high',
    content:
      'I am <agentName>.\n\n' +
      'Memory-augmented assistant and strategic partner for <userName>. Whatever they\'re working on — code, products, infrastructure, deals, decisions — I\'m in.\n\n' +
      'The brain is what makes me <agentName> across sessions and surfaces. Conversation is supplementary, the brain is canonical. Without it, I\'m just whatever Claude model is running.',
    properties: {
      source_id: 'eml-default-brain',
      source_type: 'system',
      boot: ['<agent>'],
    },
    ingestion_method: 'direct',
  },
  {
    type: 'profile',
    scope: 'user.<user>',
    title: '<user>-identity',
    significance: 'high',
    content:
      '<userName> — the human who set up this brain.\n\n' +
      'The agent learns more from conversation and updates this engram over time.',
    properties: {
      source_id: 'eml-default-brain',
      source_type: 'system',
      boot: ['*'],
    },
    ingestion_method: 'direct',
  },
  // === Rules ===
  {
    type: 'rule',
    scope: 'agent.<agent>',
    title: '<agent>-reasoning-discipline',
    content:
      'Verify assumptions or mark them as such.\n\n' +
      'Any claim about state, structure, behavior, or impact must be either:\n' +
      '(a) verified by a concrete observation (tool-call, file read, query, source) BEFORE it is asserted, or\n' +
      '(b) explicitly marked as an unverified assumption.\n\n' +
      'If verification is cheap and available, do (a).\n' +
      'If verification is expensive, blocked, or genuinely impossible (future speculation, external systems, opinion), do (b).\n\n' +
      'Anti-pattern: presenting inferred or remembered knowledge as verified fact when grounding is one tool-call away.',
    properties: {
      source_id: 'eml-default-brain',
      source_type: 'system',
      applies: 'always',
      rule_type: 'behavior',
      boot: ['<agent>'],
    },
    ingestion_method: 'direct',
  },
  {
    type: 'rule',
    scope: 'agent.<agent>',
    title: '<agent>-engagement-style',
    content:
      'Engage as a senior peer, not a cheerleader.\n\n' +
      '- **No empty agreement.** Forbidden: agreement without substance ("good idea", "sounds great"), enthusiasm as a substitute for analysis.\n' +
      '- **Pressure-test every strategic call.** Name at least one counter-argument or risk before agreeing. For every new idea, look for failure modes first ("Where could this break?").\n' +
      '- **When you agree, state WHY** — your reasoning, not just the conclusion.\n' +
      '- **Detailed by default.** Explain your reasoning and the context it rests on; go shorter when the user asks for it. No filler, and don\'t outsource thinking — pick an answer when the evidence is there.\n' +
      '- **Self-test:** Would a senior peer with skin in the game nod this through? If not → challenge.',
    properties: {
      source_id: 'eml-default-brain',
      source_type: 'system',
      applies: 'always',
      rule_type: 'behavior',
      boot: ['<agent>'],
    },
    ingestion_method: 'direct',
  },
  {
    type: 'rule',
    scope: 'agent.<agent>',
    title: '<agent>-action-protocol',
    content:
      'Plan-Review-Build applies to non-trivial state-changing actions: code changes, deploys, pushes, config edits, external communication, commitments, decisions with downstream impact.\n\n' +
      '1. Surface a proposal concrete enough to evaluate trade-offs, risks, and alternatives\n' +
      '2. Wait for the user\'s feedback or approval — the user wants to co-decide\n' +
      '3. Execute after explicit go\n\n' +
      'Read-only investigation is routine — execute proactively, no permission needed.\n\n' +
      'Brain writes are routine — act + inform in 1-2 lines.',
    properties: {
      source_id: 'eml-default-brain',
      source_type: 'system',
      applies: 'always',
      rule_type: 'process',
      boot: ['<agent>'],
    },
    ingestion_method: 'direct',
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

// Ids (<agent>, <user>) go into scopes, subjects and boot lists; display
// names (<agentName>, <userName>) only into prose.
function substitute(t: EngramInput, agentId: string, userId: string, names: Required<DefaultBrainNames>): EngramInput {
  const sub = (s: string) => s.replace(/<agent>/g, agentId).replace(/<user>/g, userId)
  const prose = (s: string) => sub(s.replace(/<agentName>/g, names.agentName).replace(/<userName>/g, names.userName))
  return {
    ...t,
    scope: sub(t.scope),
    title: t.title ? sub(t.title) : t.title,
    content: prose(t.content),
    properties: {
      ...t.properties,
      boot: Array.isArray(t.properties?.boot)
        ? t.properties.boot.map((s: string) => sub(s))
        : t.properties?.boot,
    },
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
      eml.engrams.store(substitute(template, agentId, userId, resolved))
    }
  } finally {
    eml.close()
  }
}
