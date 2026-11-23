// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { LimitsPanel, limitsLabel } from './LimitsPanel';

const base = { deniedTools: [], mcpServers: null, job: null, liftable: false };
const blocked = { deniedTools: ['mcp__gmail__send_email', 'mcp__gmail__reply_to_email'], mcpServers: null, liftable: true };
const job = { id: 'job-1', name: 'Weekly analysis' };

afterEach(() => { cleanup(); });

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

describe('the limits panel', () => {
  it('lists the blocked tools and the job, and lifts them for its future runs too by default', () => {
    const onLift = vi.fn();
    render(<LimitsPanel limits={{ ...blocked, job }} running={false} onLift={onLift} onClose={() => {}} />);
    expect(screen.getByText('mcp__gmail__send_email')).toBeTruthy();
    expect(screen.getByText('Set by the job "Weekly analysis".')).toBeTruthy();
    expect((screen.getByRole('checkbox', { name: 'Also for future runs of this job' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Restart without limits' }));
    expect(onLift).toHaveBeenCalledWith(true);
  });

  it('lifts them for this session only once the box is unticked', () => {
    const onLift = vi.fn();
    render(<LimitsPanel limits={{ ...blocked, job }} running={false} onLift={onLift} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Also for future runs of this job' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restart without limits' }));
    expect(onLift).toHaveBeenCalledWith(false);
  });

  it('offers no job choice for a session no job started', () => {
    const onLift = vi.fn();
    render(<LimitsPanel limits={{ ...blocked, job: null }} running onLift={onLift} onClose={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Stop turn and restart without limits' }));
    expect(onLift).toHaveBeenCalledWith(false);
  });

  it('has no lift for limits it cannot lift, and says where tools are lent instead', () => {
    render(<LimitsPanel limits={{ ...blocked, job, liftable: false }} running={false} onLift={() => {}} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /without limits/ })).toBeNull();
    expect(screen.getByText(/Lend it tools in the Jobs view/)).toBeTruthy();
  });
});
