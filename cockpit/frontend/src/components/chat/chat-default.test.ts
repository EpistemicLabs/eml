import { describe, expect, it } from 'vitest';

import { shouldOpenInChat } from './chat-default';

describe('shouldOpenInChat', () => {
  const base = { view: 'terminal', runtime: null, phoneDefault: true, pickedView: undefined, provider: 'claude', queuedCommand: false };

  it('opens a terminal pane in chat on a phone', () => {
    expect(shouldOpenInChat(base)).toBe(true);
  });

  it('a session that last ran in chat stays there, also off the phone', () => {
    expect(shouldOpenInChat({ ...base, phoneDefault: false, runtime: 'sdk' })).toBe(true);
    expect(shouldOpenInChat({ ...base, pickedView: 'terminal', runtime: 'sdk' })).toBe(true);
  });

  it.each([
    ['off the phone or with the setting off', { phoneDefault: false }],
    ['the user picked the terminal here', { pickedView: 'terminal' }],
    ['it is a Codex session', { provider: 'codex' }],
    ['a worker command waits', { queuedCommand: true }],
    ['the pane shows something else', { view: 'brain' }],
  ])('leaves it alone when %s', (_why, patch) => {
    expect(shouldOpenInChat({ ...base, ...patch })).toBe(false);
  });
});
