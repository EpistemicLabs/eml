import { describe, expect, it } from 'vitest';

import type { AgentProviderInfo, Capability } from '@/lib/providers';

import { agentGroups, choiceValue, defaultChoice, entryOf, parseChoice } from './agent-options';

const yes: Capability = { supported: true };
const no: Capability = { supported: false, reason: 'Terminal only.' };

const provider = (id: string, label: string, over: Partial<AgentProviderInfo> = {}, chat: Capability = yes) => ({
  id, label, version: '1.0.0', problem: null, problemHint: '', signedIn: true, isDefault: false, settings: null,
  runtime: { channel: 'latest', autoUpdate: true, current: '1.0.0', previous: null, lastCheckAt: null, lastResult: null },
  capabilities: { chat, endTurnTool: yes, messaging: yes },
  ...over,
}) as AgentProviderInfo;

const model = (id: string, label: string) => ({ id, label, description: `${label} model`, resolved: null });

describe('agentGroups', () => {
  it('offers every set-up agent with a chat, with its default model and its models, in the host\'s order', () => {
    const groups = agentGroups(
      [
        provider('claude', 'Claude Code'),
        provider('codex', 'Codex'),
        provider('qwen', 'Qwen Code', {}, no),
        provider('later', 'Not Installed', { version: null }),
      ],
      [{ id: 'claude', models: [model('opus', 'Opus 5.5'), model('opus', 'Opus 5.5')] }, { id: 'codex', models: [model('gpt-6-luna', 'GPT-6 Luna')] }],
    );
    expect(groups.map((group) => [group.label, group.entries.map((entry) => entry.label)])).toEqual([
      ['Claude Code', ['Claude Code · default model', 'Claude Code · Opus 5.5']],
      ['Codex', ['Codex · default model', 'Codex · GPT-6 Luna']],
    ]);
    expect(groups[1].entries[1].choice).toEqual({ provider: 'codex', model: 'gpt-6-luna' });
  });

  it('offers an agent no code here names, as soon as the host reports it with a chat', () => {
    const groups = agentGroups([provider('claude', 'Claude Code'), provider('newcomer', 'Newcomer CLI')], [{ id: 'newcomer', models: [model('nc-1', 'NC One')] }]);
    expect(groups.map((group) => group.provider)).toEqual(['claude', 'newcomer']);
    expect(groups[1].entries.map((entry) => entry.label)).toEqual(['Newcomer CLI · default model', 'Newcomer CLI · NC One']);
  });

  it('keeps an agent that is not signed in or not ready, with a note; one without models offers its default model', () => {
    const groups = agentGroups([provider('codex', 'Codex', { signedIn: false }), provider('other', 'Other', { problem: 'Damaged.' })], undefined);
    expect(groups.map((group) => [group.note, group.entries.length])).toEqual([['not signed in', 1], ['not ready', 1]]);
  });

  it('offers nothing before the host answered, or from a host that sends no capabilities', () => {
    expect(agentGroups(undefined, undefined)).toEqual([]);
    expect(agentGroups([{ ...provider('claude', 'Claude Code'), capabilities: undefined }], undefined)).toEqual([]);
  });
});

describe('defaultChoice', () => {
  it('starts on the default agent (Settings › Models) with its default model, else the first offered', () => {
    const providers = [provider('claude', 'Claude Code'), provider('codex', 'Codex', { isDefault: true }), provider('qwen', 'Qwen Code', { isDefault: false }, no)];
    const groups = agentGroups(providers, [{ id: 'codex', models: [model('gpt-6-luna', 'GPT-6 Luna')] }]);
    expect(defaultChoice(groups, providers)).toEqual({ provider: 'codex', model: null });
    // The default has no chat: the first agent that has one.
    const qwenFirst = [provider('claude', 'Claude Code'), provider('qwen', 'Qwen Code', { isDefault: true }, no)];
    expect(defaultChoice(agentGroups(qwenFirst, undefined), qwenFirst)).toEqual({ provider: 'claude', model: null });
    expect(defaultChoice([], providers)).toBeNull();
  });
});

describe('choice values', () => {
  it('round-trip, and find their entry while it is still offered', () => {
    const groups = agentGroups([provider('claude', 'Claude Code')], [{ id: 'claude', models: [model('opus[1m]', 'Opus 1M')] }]);
    const choice = { provider: 'claude', model: 'opus[1m]' };
    expect(parseChoice(choiceValue(choice))).toEqual(choice);
    expect(parseChoice('nonsense')).toBeNull();
    expect(entryOf(groups, choice)?.label).toBe('Claude Code · Opus 1M');
    expect(entryOf(groups, { provider: 'codex', model: null })).toBeNull();
  });
});
