import { describe, expect, it } from 'vitest';

import { heldCommandAfter, shouldOpenInChat, startsInChat } from './chat-default';

describe('shouldOpenInChat', () => {
  const base = { view: 'terminal', runtime: null, chatDefault: true, pickedView: undefined, provider: 'claude', queuedCommand: false };

  it('opens a terminal pane in chat', () => {
    expect(shouldOpenInChat(base)).toBe(true);
  });

  it('a session that last ran in chat stays there, also with the setting off', () => {
    expect(shouldOpenInChat({ ...base, chatDefault: false, runtime: 'sdk' })).toBe(true);
    expect(shouldOpenInChat({ ...base, pickedView: 'terminal', runtime: 'sdk' })).toBe(true);
  });

  it.each([
    ['the setting is off', { chatDefault: false }],
    ['the user picked the terminal here', { pickedView: 'terminal' }],
    ['it is a Codex session', { provider: 'codex' }],
    ['a worker command waits', { queuedCommand: true }],
    ['the pane shows something else', { view: 'brain' }],
  ])('leaves it alone when %s', (_why, patch) => {
    expect(shouldOpenInChat({ ...base, ...patch })).toBe(false);
  });
});

describe('heldCommandAfter', () => {
  it('drops the command once the first turn is done', () => {
    expect(heldCommandAfter('prompt', 'done')).toBeNull();
  });

  it.each([undefined, 'idle', 'working', 'waiting'])('keeps it while the turn is %s', (state) => {
    expect(heldCommandAfter('prompt', state)).toBe('prompt');
  });

  it('leaves a command not read yet alone until it is done', () => {
    expect(heldCommandAfter(undefined, 'working')).toBeUndefined();
  });
});

describe('startsInChat', () => {
  it('opens a new Claude session in chat', () => {
    expect(startsInChat({ chatDefault: true, provider: 'claude' })).toBe(true);
  });

  it.each([
    ['the setting is off', { chatDefault: false, provider: 'claude' }],
    ['it is a Codex session', { chatDefault: true, provider: 'codex' }],
    ['the default provider is not known yet', { chatDefault: true, provider: null }],
  ])('stays in the terminal when %s', (_why, session) => {
    expect(startsInChat(session)).toBe(false);
  });
});
