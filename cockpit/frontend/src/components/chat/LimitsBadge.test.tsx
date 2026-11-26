// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setLimits } from './chat-store';
import { isLimited, LimitsBadge, limitsActions, limitsName } from './LimitsBadge';

const sent: Array<Record<string, unknown>> = [];
vi.mock('./useChatSocket', () => ({ liftLimits: (sessionId: string, forJob: boolean) => { sent.push({ sessionId, forJob }); return true; } }));

const base = { deniedTools: [], mcpServers: null, job: null, liftable: false };
const blocked = { deniedTools: ['mcp__gmail__send_email', 'mcp__gmail__reply_to_email'], mcpServers: null, liftable: true };
const job = { id: 'job-1', name: 'Weekly analysis' };

afterEach(() => { cleanup(); sent.length = 0; });

describe('isLimited and limitsName', () => {
  it('shows nothing for a session without limits, or before the host said', () => {
    expect(isLimited(null)).toBe(false);
    expect(isLimited(base)).toBe(false);
  });

  it('counts what is off', () => {
    expect(limitsName({ ...base, deniedTools: ['a'] })).toBe('Limited: 1 tool off');
    expect(limitsName({ ...base, ...blocked })).toBe('Limited: 2 tools off');
    expect(limitsName({ ...base, mcpServers: [] })).toBe('Limited: some MCP servers only');
  });
});

describe('limitsActions', () => {
  it('offers this session, and with a job its future runs too', () => {
    expect(limitsActions({ ...blocked, job }, () => {}).map((a) => a.label)).toEqual(['Allow in this session', 'Allow in this session and future runs']);
    expect(limitsActions({ ...blocked, job: null }, () => {}).map((a) => a.label)).toEqual(['Allow in this session']);
  });

  it('offers nothing for limits it cannot lift', () => {
    expect(limitsActions({ ...blocked, job, liftable: false }, () => {})).toEqual([]);
  });
});

describe('the limits badge', () => {
  it('lists what is off in readable names and lifts it for the job\'s future runs when asked', () => {
    setLimits('s-badge-1', { ...blocked, job });
    render(<LimitsBadge sessionId="s-badge-1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Limited: 2 tools off' }));
    expect(screen.getByText('This session of a task\'s schedule can\'t use:')).toBeTruthy();
    expect(screen.getByText('Gmail · Send email')).toBeTruthy();
    expect(screen.getByText('Gmail · Reply to email')).toBeTruthy();
    expect(screen.queryByText('mcp__gmail__send_email')).toBeNull();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Allow in this session and future runs' }));
    expect(sent).toEqual([{ sessionId: 's-badge-1', forJob: true }]);
  });

  it('lifts it for this session only', () => {
    setLimits('s-badge-2', { ...blocked, job });
    render(<LimitsBadge sessionId="s-badge-2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Limited: 2 tools off' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Allow in this session' }));
    expect(sent).toEqual([{ sessionId: 's-badge-2', forJob: false }]);
  });

  it('says where tools are lent when it cannot lift them', () => {
    setLimits('s-badge-3', { ...blocked, job, liftable: false });
    render(<LimitsBadge sessionId="s-badge-3" />);
    fireEvent.click(screen.getByRole('button', { name: 'Limited: 2 tools off' }));
    expect(screen.queryAllByRole('menuitem')).toEqual([]);
    expect(screen.getByText(/It runs for a task that answers messages from outside\. Lend it tools in its task's panel, under Schedule/)).toBeTruthy();
  });

  it('is not there for a session without limits', () => {
    setLimits('s-badge-4', base);
    render(<LimitsBadge sessionId="s-badge-4" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
