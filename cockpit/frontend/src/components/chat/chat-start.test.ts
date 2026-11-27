import { describe, expect, it } from 'vitest';

import { chatProvider, type AgentProviderInfo, type Capability } from '@/lib/providers';

import { chatInitFrame } from './chat-start';

const no: Capability = { supported: false, reason: 'No chat view for this CLI.' };
const yes: Capability = { supported: true };
const provider = (id: AgentProviderInfo['id'], chat: Capability) =>
  ({ id, label: id, capabilities: { chat, endTurnTool: yes, messaging: yes } }) as AgentProviderInfo;

const frame = (over: Partial<Parameters<typeof chatInitFrame>[0]> = {}) => chatInitFrame({
  paneId: 'pane-1', projectId: 'p1', sessionId: 's1', spaceId: null, resume: { epoch: 3, after: 12 }, wait: false, greet: true, provider: null, start: null, ...over,
});

describe('chatInitFrame', () => {
  it('names the provider a new chat starts with, so the host does not fall back to its own', () => {
    expect(frame({ provider: 'codex' })).toEqual({
      type: 'init', paneId: 'pane-1', projectId: 'p1', sessionId: 's1', spaceId: null, epoch: 3, after: 12, readOnly: true, greet: true, provider: 'codex',
    });
  });

  it('names none when the view knows none: the host then starts its default, as before', () => {
    expect(frame()).not.toHaveProperty('provider');
  });

  it('brings the launcher\'s first message and model, and asks to wait for the terminal', () => {
    expect(frame({ wait: true, start: { provider: null, prompt: 'Fix the import', model: 'gpt-6-luna' }, provider: 'codex' }))
      .toMatchObject({ whenIdle: true, prompt: 'Fix the import', model: 'gpt-6-luna', provider: 'codex' });
    expect(frame({ start: { provider: null, prompt: null, model: null } })).not.toHaveProperty('prompt');
  });

  it('names the agent the launcher\'s picker chose before the pane\'s', () => {
    expect(frame({ start: { provider: 'newcomer', prompt: null, model: 'nc-1' }, provider: 'claude' }))
      .toMatchObject({ provider: 'newcomer', model: 'nc-1' });
  });
});

describe('chatProvider', () => {
  const providers = [provider('claude', yes), provider('codex', yes), provider('qwen', no)];

  it('is the provider the pane was opened for, else the cockpit\'s default', () => {
    expect(chatProvider(providers, 'codex', 'claude')).toBe('codex');
    expect(chatProvider(providers, undefined, 'codex')).toBe('codex');
    expect(chatProvider(providers, undefined, 'claude')).toBe('claude');
  });

  it('names no provider that has no chat: the host decides, as it did before', () => {
    expect(chatProvider(providers, 'qwen', 'claude')).toBeNull();
    expect(chatProvider([provider('claude', yes), provider('codex', no)], undefined, 'codex')).toBeNull();
    expect(chatProvider(undefined, undefined, null)).toBeNull();
    // Before the host answered, only Claude Code is known to have one.
    expect(chatProvider(undefined, 'codex', null)).toBeNull();
    expect(chatProvider(undefined, 'claude', null)).toBe('claude');
  });
});
