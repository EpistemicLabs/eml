import { describe, expect, it } from 'vitest';

import { shouldPoll } from './ToolServersPanel';
import type { ToolServer } from './chat-state';

const server = (status: ToolServer['status']): ToolServer => ({ name: 'x', status, error: null, scope: null, transport: null, toolCount: 0 });

describe('shouldPoll', () => {
  it('looks again only while a server is connecting', () => {
    expect(shouldPoll(null)).toBe(false);
    expect(shouldPoll([server('connected'), server('needs-auth')])).toBe(false);
    expect(shouldPoll([server('connected'), server('pending')])).toBe(true);
  });
});
