// Settings › Agents: the home's agents, and the picked one read from its own
// brain (host GET /api/agents, GET /api/agents/:id/brain/…), the active space's
// until another is picked: where it works, its persona (the core profile in agent.<id>), its rules (in
// agent.<id> and in user.<handle> — the ones about the person are marked):
// those that load in every session (applies: always), then the situational
// ones with their trigger, collapsed as a whole — and what it knows about the people it
// works with (the core profiles in user.*). Read-only: the agent keeps these
// engrams itself when you ask it to. An entry written before the short format
// (rule over 200, profile over 400 characters) loads by title only — the boot
// counts it as legacy (core boot.ts); this tab says so.
import { useEffect, useState } from 'react';

import type { Engram, ListResponse } from '@/lib/types';
import { useActiveSpace } from '@/stores/useSpaceStore';
import { useAgents, type AgentInfo } from '../../hooks/useAgents';
import SettingsCard from '../SettingsCard';
import SettingsHeading from '../SettingsHeading';
import SettingsPicker from '../SettingsPicker';
import type { SettingsMainTabMeta } from '../../constants/constants';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

type AgentEngrams = { persona: Engram | null; rules: Engram[]; situational: Engram[]; people: Engram[] };

// The short format's limits (core validate.ts).
const RULE_MAX_CHARS = 200;
const PROFILE_MAX_CHARS = 400;

async function agentGet(agentId: string, params: Record<string, string>): Promise<ListResponse> {
  const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/brain/list?${new URLSearchParams(params)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as ListResponse;
}

function useAgentEngrams(agentId: string | null, handle: string | null): { data: AgentEngrams | null; failed: boolean } {
  const [data, setData] = useState<AgentEngrams | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setData(null);
    setFailed(false);
    if (!agentId) return;
    let cancelled = false;
    const own = `agent.${agentId}`;
    Promise.all([
      agentGet(agentId, { type: 'profile', status: 'active', limit: '100' }),
      agentGet(agentId, { type: 'rule', scope: own, status: 'active', limit: '100' }),
      handle ? agentGet(agentId, { type: 'rule', scope: `user.${handle}`, status: 'active', limit: '100' }) : Promise.resolve({ count: 0, engrams: [] } as ListResponse),
    ]).then(
      ([profiles, ownRules, userRules]) => {
        if (cancelled) return;
        const core = profiles.engrams.filter((e) => e.properties?.core === true);
        // By the shown label: the agent's own titles carry its id as a prefix.
        const rules = [...ownRules.engrams, ...userRules.engrams].sort((a, b) => ruleLabel(a, agentId).localeCompare(ruleLabel(b, agentId)));
        setData({
          persona: core.find((e) => e.scope === own) ?? null,
          rules: rules.filter((e) => e.properties?.applies === 'always'),
          situational: rules.filter((e) => e.properties?.applies !== 'always'),
          people: core.filter((e) => e.scope.startsWith('user.')).sort((a, b) => a.scope.localeCompare(b.scope)),
        });
      },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [agentId, handle]);

  return { data, failed };
}

export default function AgentTab({ tab: meta }: { tab: SettingsMainTabMeta }) {
  const space = useActiveSpace();
  const { agents, handle, loaded, failed: agentsFailed } = useAgents();
  const [pickedId, setPickedId] = useState<string | null>(null);
  // The picked agent, else the active space's; a space without one shows the first agent of the home, if any.
  const shownId = pickedId ?? space?.agent;
  const agent: AgentInfo | null = (shownId ? agents.find((a) => a.id === shownId) : undefined) ?? agents[0] ?? null;
  const { data, failed } = useAgentEngrams(agent?.id ?? null, handle);
  const fallback = agentsFailed || failed ? 'unavailable' : '…';
  const name = agent?.name ?? 'your agent';

  if (loaded && !agent) {
    return (
      <div className="space-y-4">
        <SettingsHeading tab={meta} />
        <div className="text-sm text-muted-foreground">
          This cockpit has no agent yet. The space's banner says what the agent upgrade waits for.
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {agents.length === 0 && <div className="text-sm text-muted-foreground">{fallback}</div>}
      <div className="space-y-4">
        <SettingsHeading tab={meta} description="Each agent has its own brain with its persona, rules and learnings. To change any of this, ask your agent in a session." />
        <div>
          <SettingsPicker
            items={agents.map((a) => ({ id: a.id, label: a.name }))}
            value={agent?.id}
            onChange={setPickedId}
            ariaLabel="Agents"
          />
          {agent && (
          <div className="space-y-8 rounded-xl rounded-tl-none border border-foreground/10 p-4">
            <SettingsSection title="Details">
              <SettingsCard divided>
                <SettingsRow label="Writes as" description="The agent stamped on every engram its sessions write">
                  <span className="block font-mono text-xs text-foreground">{agent.id}</span>
                </SettingsRow>
                <div className="px-4 py-4">
                  <div className="text-sm font-medium text-foreground">Works in the following spaces</div>
                  {agent.spaces.length === 0 && <div className="mt-1 text-sm text-muted-foreground">No space yet.</div>}
                  <ul className="mt-1 space-y-0.5">
                    {agent.spaces.map((s) => <li key={s.id} className="text-sm text-muted-foreground">{s.name}</li>)}
                  </ul>
                </div>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="Persona" description={`Who ${name} is. Loaded at the start of every session in the spaces it works in.`}>
              <SettingsCard>
                <div className="px-4 py-4 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
                  {data ? data.persona?.content ?? 'No persona yet.' : <span className="text-muted-foreground">{fallback}</span>}
                </div>
                {data?.persona && data.persona.content.length > PROFILE_MAX_CHARS && (
                  <div className="px-4 pb-4 text-xs text-muted-foreground">{legacyNote('profile', PROFILE_MAX_CHARS)}</div>
                )}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection
              title="Always-on rules"
              description={`How ${name} works with you. Loaded in every session.`}
            >
              <SettingsCard divided>
                {!data && <div className="px-4 py-4 text-sm text-muted-foreground">{fallback}</div>}
                {data && data.rules.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">No always-on rules.</div>}
                {data?.rules.map((rule) => <RuleRow key={rule.id} rule={rule} agentId={agent.id} />)}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection
              title="Situational rules"
              description={`Listed by title in every session; ${name} reads one in full when its trigger applies.`}
            >
              <SettingsCard>
                {!data && <div className="px-4 py-4 text-sm text-muted-foreground">{fallback}</div>}
                {data && data.situational.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">No situational rules.</div>}
                {data && data.situational.length > 0 && (
                  <details className="group/all">
                    <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-foreground">
                      <span className="mr-2 inline-block text-muted-foreground transition-transform group-open/all:rotate-90">›</span>
                      {data.situational.length} situational {data.situational.length === 1 ? 'rule' : 'rules'}
                    </summary>
                    <div className="divide-y divide-foreground/8 border-t border-foreground/8">
                      {data.situational.map((rule) => <RuleRow key={rule.id} rule={rule} agentId={agent.id} />)}
                    </div>
                  </details>
                )}
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="People" description={`What ${name} knows about the people it works with.`}>
              <SettingsCard divided>
                {!data && <div className="px-4 py-4 text-sm text-muted-foreground">{fallback}</div>}
                {data && data.people.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">Nothing yet — it learns from your sessions.</div>}
                {data?.people.map((profile) => (
                  <div key={profile.id} className="px-4 py-3">
                    <div className="font-mono text-xs text-muted-foreground">{profile.scope.slice('user.'.length)}</div>
                    <div className="mt-1 text-sm leading-relaxed whitespace-pre-wrap text-foreground">{profile.content}</div>
                    {profile.content.length > PROFILE_MAX_CHARS && (
                      <div className="mt-2 text-xs text-muted-foreground">{legacyNote('profile', PROFILE_MAX_CHARS)}</div>
                    )}
                  </div>
                ))}
              </SettingsCard>
            </SettingsSection>
          </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One rule: its label (and trigger, for a situational one), the content on opening. */
function RuleRow({ rule, agentId }: { rule: Engram; agentId: string }) {
  const trigger = typeof rule.properties?.trigger === 'string' ? rule.properties.trigger : null;
  return (
    <details className="group px-4 py-3">
      <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
        <span className="mr-2 inline-block text-muted-foreground transition-transform group-open:rotate-90">›</span>
        {ruleLabel(rule, agentId)}
        {trigger && <div className="mt-0.5 pl-4 text-xs font-normal text-muted-foreground">When: {trigger}</div>}
      </summary>
      <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{rule.content}</div>
      {rule.content.length > RULE_MAX_CHARS && (
        <div className="mt-2 text-xs text-muted-foreground">{legacyNote('rule', RULE_MAX_CHARS)}</div>
      )}
    </details>
  );
}

function legacyNote(kind: 'rule' | 'profile', max: number): string {
  return `Loads by title only until it is shortened to ${max} characters — ask your agent to rewrite this ${kind}.`;
}

/** "juno-engagement-style" → "Engagement style". */
function ruleLabel(rule: Engram, agentId: string): string {
  const title = rule.title ?? rule.content.split('\n')[0];
  const bare = agentId && title.startsWith(`${agentId}-`) ? title.slice(agentId.length + 1) : title;
  const words = bare.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : title;
}
