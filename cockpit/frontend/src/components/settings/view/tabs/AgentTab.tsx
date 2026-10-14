// Settings › Agent: the agent this brain was set up with — its name, its
// profile (<agent>-identity) and the rules it loads in every session
// (applies: always). Read-only: the agent keeps these engrams itself when you
// ask it to; editing them here, and choosing which agent with which settings a
// space uses, come later.
import { useEffect, useState } from 'react';

import { brainGet } from '@/lib/api';
import type { Engram, ListResponse } from '@/lib/types';
import { mainAgent, useBrainInfo } from '../../hooks/useBrainInfo';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';

type AgentEngrams = { profile: Engram | null; rules: Engram[] };

function useAgentEngrams(agentId: string | null): { data: AgentEngrams | null; failed: boolean } {
  const [data, setData] = useState<AgentEngrams | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!agentId) return;
    let cancelled = false;
    const scope = `agent.${agentId}`;
    Promise.all([
      brainGet<ListResponse>('/list', { type: 'profile', scope, status: 'active', limit: 50 }),
      brainGet<ListResponse>('/list', { type: 'rule', scope, status: 'active', limit: 100 }),
    ]).then(
      ([profiles, rules]) => {
        if (cancelled) return;
        setData({
          profile: profiles.engrams.find((e) => e.title === `${agentId}-identity`) ?? profiles.engrams[0] ?? null,
          rules: rules.engrams
            .filter((e) => e.properties?.applies === 'always')
            .sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '')),
        });
      },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [agentId]);

  return { data, failed };
}

export default function AgentTab() {
  const { info, failed: infoFailed } = useBrainInfo();
  const agent = mainAgent(info);
  const { data, failed } = useAgentEngrams(agent?.id ?? null);
  const fallback = infoFailed || failed ? 'unavailable' : '…';

  return (
    <div className="space-y-8">
      <SettingsSection title="Agent">
        <SettingsCard divided>
          <SettingsRow label="Name" description="How your agent introduces itself">
            <span className="text-sm text-foreground">{info ? agent?.name ?? '—' : fallback}</span>
          </SettingsRow>
          <SettingsRow label="Handle" description="Its fixed id in the brain">
            <span className="block font-mono text-xs text-foreground">{info ? agent?.id ?? '—' : fallback}</span>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Profile" description="Who your agent is. It loads this at the start of every session.">
        <SettingsCard>
          <div className="px-4 py-4 text-sm leading-relaxed whitespace-pre-wrap text-foreground">
            {data ? data.profile?.content ?? 'No profile yet.' : <span className="text-muted-foreground">{fallback}</span>}
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Always-on rules"
        description="How your agent works with you. It loads these in every session; other rules apply only in situations they name."
      >
        <SettingsCard divided>
          {!data && <div className="px-4 py-4 text-sm text-muted-foreground">{fallback}</div>}
          {data && data.rules.length === 0 && <div className="px-4 py-4 text-sm text-muted-foreground">No always-on rules.</div>}
          {data?.rules.map((rule) => (
            <details key={rule.id} className="group px-4 py-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-foreground">
                <span className="mr-2 inline-block text-muted-foreground transition-transform group-open:rotate-90">›</span>
                {ruleLabel(rule, agent?.id ?? '')}
              </summary>
              <div className="mt-2 text-sm leading-relaxed whitespace-pre-wrap text-muted-foreground">{rule.content}</div>
            </details>
          ))}
        </SettingsCard>
      </SettingsSection>

      <div className="text-sm text-muted-foreground">
        To change any of this, ask your agent in a session — it updates its own profile and rules. Editing them here,
        and choosing which agent with which settings a space uses, come later.
      </div>
    </div>
  );
}

/** "juno-engagement-style" → "Engagement style". */
function ruleLabel(rule: Engram, agentId: string): string {
  const title = rule.title ?? rule.content.split('\n')[0];
  const bare = agentId && title.startsWith(`${agentId}-`) ? title.slice(agentId.length + 1) : title;
  const words = bare.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}
