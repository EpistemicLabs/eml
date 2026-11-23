import { describe, expect, it } from 'vitest';

import { limitsLabel } from './LimitsPanel';

const base = { deniedTools: [], mcpServers: null, job: null, liftable: false };

describe('limitsLabel', () => {
  it('shows nothing for a session without limits, or before the host said', () => {
    expect(limitsLabel(null)).toBeNull();
    expect(limitsLabel(base)).toBeNull();
  });

  it('counts the blocked tools', () => {
    expect(limitsLabel({ ...base, deniedTools: ['a'] })).toBe('1 tool blocked');
    expect(limitsLabel({ ...base, deniedTools: ['a', 'b'] })).toBe('2 tools blocked');
  });

  it('names a limit to some MCP servers when no tool is blocked', () => {
    expect(limitsLabel({ ...base, mcpServers: [] })).toBe('MCP limited');
  });
});
