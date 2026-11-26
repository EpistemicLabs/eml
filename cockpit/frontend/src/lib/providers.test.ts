import { describe, expect, it } from 'vitest';

import { providerCanChat, type AgentProviderInfo, type Capability } from './providers';

const no: Capability = { supported: false, reason: 'No chat view for this CLI.' };
const yes: Capability = { supported: true };

function provider(id: AgentProviderInfo['id'], chat?: Capability): AgentProviderInfo {
  return {
    id,
    label: id,
    version: '1.0.0',
    problem: null,
    problemHint: '',
    runtime: { channel: 'stable', autoUpdate: true, current: '1.0.0', previous: null, lastCheckAt: null, lastResult: null },
    signedIn: true,
    isDefault: id === 'claude',
    settings: null,
    ...(chat ? { capabilities: { chat, endTurnTool: chat, messaging: chat } } : {}),
  };
}

describe('providerCanChat', () => {
  it('takes the host\'s answer', () => {
    const providers = [provider('claude', yes), provider('codex', no)];
    expect(providerCanChat(providers, 'claude')).toBe(true);
    expect(providerCanChat(providers, 'codex')).toBe(false);
  });

  it('does not go by the id once the host answers', () => {
    const providers = [provider('claude', no), provider('codex', yes)];
    expect(providerCanChat(providers, 'claude')).toBe(false);
    expect(providerCanChat(providers, 'codex')).toBe(true);
  });

  it.each([
    ['the host sends no capabilities', [provider('claude'), provider('codex'), provider('qwen')]],
    ['the list is not loaded', undefined],
    ['the list is empty', []],
  ])('gives only Claude a chat when %s', (_why, providers) => {
    expect(providerCanChat(providers, 'claude')).toBe(true);
    expect(providerCanChat(providers, 'codex')).toBe(false);
    expect(providerCanChat(providers, 'qwen')).toBe(false);
  });

  it.each([null, undefined])('has no chat for a provider not known yet (%s)', (id) => {
    expect(providerCanChat([provider('claude', yes)], id)).toBe(false);
    expect(providerCanChat(undefined, id)).toBe(false);
  });
});
