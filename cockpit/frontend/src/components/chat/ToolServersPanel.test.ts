import { describe, expect, it } from 'vitest';

import { shouldPoll, signInHint } from './ToolServersPanel';
import type { ToolServer } from './chat-state';

const server = (status: ToolServer['status']): ToolServer => ({ name: 'x', status, error: null, scope: null, transport: null, toolCount: 0 });

describe('shouldPoll', () => {
  it('looks again while a server is connecting or a sign-in is under way', () => {
    expect(shouldPoll(null)).toBe(false);
    expect(shouldPoll([server('connected'), server('needs-auth')])).toBe(false);
    expect(shouldPoll([server('connected'), server('pending')])).toBe(true);
    expect(shouldPoll([server('needs-auth')], { x: { url: 'https://auth.example.com', takesCode: false } })).toBe(true);
  });
});

describe('signInHint', () => {
  const all = { toggle: true, reconnect: true, signIn: true };
  it('says where to sign in: here where the runtime can, else that the chat cannot yet; nothing when no server asks', () => {
    expect(signInHint([server('connected')], all)).toBeNull();
    expect(signInHint([server('needs-auth')], all)).toMatch(/Sign in opens the server's own page/);
    expect(signInHint([server('needs-auth')], { ...all, signIn: false })).toMatch(/cannot sign in to a server from the chat/);
  });
});
