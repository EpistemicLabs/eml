// Settings › Models › Qwen Code (beta), in the order every provider uses:
// sign-in (here: the model endpoint), permissions, version. Until the
// cockpit's own Qwen Code is set up, only the set-up row shows.
import { useEffect, useState } from 'react';

import { useSetProviderSettings, type AgentProviderInfo } from '@/lib/providers';
import { Button, Input } from '@/shared/view/ui';
import SettingsCard from '../SettingsCard';
import SettingsRow from '../SettingsRow';
import SettingsSection from '../SettingsSection';
import SettingsSegmented from '../SettingsSegmented';
import RuntimeRows from './RuntimeRows';

type QwenPermissionMode = 'auto' | 'ask' | 'off';

const RUNTIME_DESCRIPTION =
  'The cockpit runs its own Qwen Code, separate from any Qwen Code installed on this computer, with settings of its own. It talks to any OpenAI-compatible endpoint — OpenRouter, a vendor’s API or a model server of your own. Updates apply to new sessions; running ones keep their version.';
const NOT_SET_UP_HINT =
  'Downloads Qwen Code from the npm registry into the cockpit home (about 150 MB) and verifies it. Only versions out for two days are taken.';

// Host: providers/qwen/settings.ts.
const PERMISSION_MODES: ReadonlyArray<{ value: QwenPermissionMode; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Auto',
    description:
      'Auto (recommended) — Qwen Code works in its sandbox: it can only write inside the project folder. A classifier allows safe actions and refuses risky ones.',
  },
  {
    value: 'ask',
    label: 'Ask',
    description:
      'Ask — Qwen Code works in its sandbox, and every file edit and shell command comes to you; the session then shows as waiting.',
  },
  {
    value: 'off',
    label: 'Off',
    description:
      'Off — no sandbox and no questions: your sessions run every command and edit directly, anywhere on this computer. Only for throwaway work.',
  },
];

const text = (value: boolean | string | undefined) => (typeof value === 'string' ? value : '');

function EndpointRows({ qwen }: { qwen: AgentProviderInfo }) {
  const setSettings = useSetProviderSettings('qwen');
  const savedBaseUrl = text(qwen.settings?.baseUrl);
  const savedModel = text(qwen.settings?.model);
  const keySet = qwen.settings?.apiKeySet === true;
  const [baseUrl, setBaseUrl] = useState(savedBaseUrl);
  const [model, setModel] = useState(savedModel);
  const [apiKey, setApiKey] = useState('');
  useEffect(() => setBaseUrl(savedBaseUrl), [savedBaseUrl]);
  useEffect(() => setModel(savedModel), [savedModel]);

  const changed = baseUrl.trim() !== savedBaseUrl || model.trim() !== savedModel || apiKey.trim() !== '';
  // Sessions need both; a key alone is no endpoint.
  const complete = baseUrl.trim() !== '' && model.trim() !== '';
  const save = () =>
    setSettings.mutate(
      { baseUrl, model, ...(apiKey.trim() ? { apiKey } : {}) },
      { onSuccess: () => setApiKey('') },
    );

  return (
    <form
      className="contents"
      onSubmit={(event) => {
        event.preventDefault();
        if (changed && complete) save();
      }}
    >
      <SettingsRow label="Base URL" description="The OpenAI-compatible endpoint, e.g. https://openrouter.ai/api/v1 or http://localhost:11434/v1.">
        <Input
          type="url"
          spellCheck={false}
          placeholder="https://…"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          className="w-72 font-code text-ui"
        />
      </SettingsRow>
      <SettingsRow label="Model" description="The model id as the endpoint names it, e.g. qwen/qwen3.8-27b.">
        <Input
          spellCheck={false}
          placeholder="model id"
          value={model}
          onChange={(event) => setModel(event.target.value)}
          className="w-72 font-code text-ui"
        />
      </SettingsRow>
      <SettingsRow
        label="API key"
        description={
          keySet
            ? 'Set. Type a new one to replace it.'
            : 'Optional — a model server of your own may need none.'
        }
      >
        <div className="flex items-center gap-2">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={keySet ? '••••••••' : 'key'}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            className="w-52 font-code text-ui"
          />
          {keySet && (
            <Button type="button" size="sm" variant="outline" disabled={setSettings.isPending} onClick={() => setSettings.mutate({ apiKey: '' })}>
              Remove
            </Button>
          )}
        </div>
      </SettingsRow>
      <div className="flex items-center justify-between gap-4 px-4 py-3">
        <p className="text-body text-muted-foreground">
          {complete
            ? 'The key reaches each Qwen Code session in its environment, so commands the model runs there can read it. Use a key with a spending limit.'
            : 'Base URL and model are both needed before saving.'}
        </p>
        <Button type="submit" size="sm" disabled={setSettings.isPending || !changed || !complete}>
          Save
        </Button>
      </div>
      {setSettings.isError && <p className="px-4 pb-4 text-body text-stopped-ink">{setSettings.error.message}</p>}
    </form>
  );
}

export default function QwenSettings({ qwen }: { qwen: AgentProviderInfo }) {
  const setSettings = useSetProviderSettings('qwen');
  const mode: QwenPermissionMode =
    PERMISSION_MODES.find((option) => option.value === qwen.settings?.permissionMode)?.value ?? 'auto';

  if (!qwen.version) {
    return (
      <SettingsSection title="Set up Qwen Code (beta)" description={RUNTIME_DESCRIPTION}>
        <SettingsCard divided>
          <RuntimeRows provider={qwen} notSetUpHint={NOT_SET_UP_HINT} />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsSection
        title="Model endpoint"
        description={qwen.signedIn ? 'Sessions talk to this endpoint. Changes apply to sessions started from now on.' : 'Set the endpoint and model before the first session.'}
      >
        <SettingsCard divided>
          <EndpointRows qwen={qwen} />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection
        title="Permissions"
        description="How much a Qwen Code session may do without asking. Applies to sessions started from now on."
      >
        <SettingsCard divided>
          <SettingsRow label="Before risky actions" description={PERMISSION_MODES.find((option) => option.value === mode)?.description}>
            <SettingsSegmented
              value={mode}
              options={PERMISSION_MODES}
              onChange={(value) => setSettings.mutate({ permissionMode: value })}
              ariaLabel="Qwen Code permissions"
              disabled={setSettings.isPending}
            />
          </SettingsRow>
          <div className="px-4 py-3 text-body text-muted-foreground">
            Worker sessions opened by another session always run in Auto — nobody is watching them.
          </div>
          {setSettings.isError && <p className="px-4 pb-4 text-body text-stopped-ink">{setSettings.error.message}</p>}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Version" description={RUNTIME_DESCRIPTION}>
        <SettingsCard divided>
          <RuntimeRows provider={qwen} />
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}
