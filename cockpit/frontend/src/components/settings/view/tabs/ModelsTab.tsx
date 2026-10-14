// Settings › Models — the agent CLIs sessions run with. On top, which one new
// sessions start with; below, one provider at a time (opening on the default),
// each in the same order: sign-in, permissions, version. A session keeps the
// CLI it was started with; the "+" in the sidebar starts one with another.
import { useEffect, useState } from 'react';

import { useProviders, useSetDefaultProvider, type AgentProviderInfo } from '@/lib/providers';
import { cn } from '@/lib/utils';
import type { LLMProvider } from '@/types/app';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsSegmented from '../SettingsSegmented';
import ClaudeSettings from './ClaudeSettings';
import CodexSettings from './CodexSettings';

/** Codex is still beta in the cockpit — its label says so everywhere here. */
const providerLabel = (provider: AgentProviderInfo) => (provider.id === 'codex' ? `${provider.label} (beta)` : provider.label);

export default function ModelsTab({ onCloseSettings }: { onCloseSettings?: () => void }) {
  const { data: providers, isError } = useProviders({ refresh: true });
  const setDefault = useSetDefaultProvider();
  const [shown, setShown] = useState<LLMProvider | null>(null);

  const defaultProvider = providers?.find((provider) => provider.isDefault) ?? providers?.[0];
  useEffect(() => {
    if (shown === null && defaultProvider) setShown(defaultProvider.id);
  }, [shown, defaultProvider]);

  if (!providers || !defaultProvider) {
    return <p className="text-sm text-muted-foreground">{isError ? 'The cockpit host is not reachable.' : 'Checking…'}</p>;
  }

  const current = providers.find((provider) => provider.id === shown) ?? defaultProvider;
  const claude = current.id === 'claude' ? current : null;
  const codex = current.id === 'codex' ? current : null;

  return (
    <div className="space-y-8">
      <SettingsSection title="Default for new sessions">
        <SettingsCard divided>
          <SettingsRow
            label="New sessions start with"
            description="A session keeps the one it was started with. Only a CLI that is set up can be the default."
          >
            <SettingsSegmented
              value={defaultProvider.id}
              options={providers.map((provider) => ({ value: provider.id, label: providerLabel(provider), disabled: !provider.version }))}
              onChange={(id) => setDefault.mutate(id)}
              ariaLabel="Default for new sessions"
              disabled={setDefault.isPending}
            />
          </SettingsRow>
          {setDefault.isError && <p className="px-4 pb-4 text-sm text-destructive">{setDefault.error.message}</p>}
        </SettingsCard>
      </SettingsSection>

      <div className="space-y-6">
        {/* Tabs, not a segmented control — it must not read like the default switch above. */}
        <div role="tablist" aria-label="Provider settings" className="flex gap-5 border-b border-foreground/8">
          {providers.map((provider) => (
            <button
              key={provider.id}
              type="button"
              role="tab"
              aria-selected={provider.id === current.id}
              onClick={() => setShown(provider.id)}
              className={cn(
                '-mb-px border-b-2 pb-2 text-sm font-medium transition-colors',
                provider.id === current.id
                  ? 'border-foreground text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {providerLabel(provider)}
            </button>
          ))}
        </div>
        {claude && <ClaudeSettings claude={claude} onCloseSettings={onCloseSettings} />}
        {codex && <CodexSettings codex={codex} onCloseSettings={onCloseSettings} />}
      </div>
    </div>
  );
}
