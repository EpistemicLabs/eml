// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAppUpdate, type AppUpdateStatus } from '@/hooks/useAppUpdate';
import AboutTab from './AboutTab';

// Settings › About › Updates: the update channel, stable or alpha (experimental).

vi.mock('@/hooks/useAboutInfo', () => ({ useAboutInfo: () => ({ info: null, failed: false }) }));
vi.mock('@/lib/providers', () => ({ useProviders: () => ({ data: [] }) }));
vi.mock('@/hooks/useAppUpdate', () => ({ useAppUpdate: vi.fn() }));

const status = (patch: Partial<AppUpdateStatus> = {}): AppUpdateStatus => ({
  managed: true,
  channel: 'stable',
  current: '0.21.5',
  previous: null,
  latest: { version: '0.21.5', url: 'https://example.test', publishedAt: null },
  available: false,
  lastCheckAt: null,
  error: null,
  lastResult: null,
  token: { source: 'none' },
  canRollback: false,
  rollbackBlocked: null,
  busy: false,
  ...patch,
});

const setChannel = vi.fn();
const mockHook = (s: AppUpdateStatus) => {
  vi.mocked(useAppUpdate).mockReturnValue({
    status: s, phase: 'idle', error: null,
    refresh: vi.fn(), check: vi.fn(), apply: vi.fn(), rollback: vi.fn(), setToken: vi.fn(), setChannel,
  } as ReturnType<typeof useAppUpdate>);
};
const channel = (name: string) => screen.getByRole('radio', { name });

beforeEach(() => mockHook(status()));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AboutTab › Updates › Channel', () => {
  it('is on stable, with releases only and no warning', () => {
    render(<AboutTab />);
    expect(channel('Stable').getAttribute('aria-checked')).toBe('true');
    expect(channel('Alpha (experimental)').getAttribute('aria-checked')).toBe('false');
    expect(screen.queryByText(/Things may break/)).toBeNull();
  });

  it('switches to alpha', () => {
    render(<AboutTab />);
    fireEvent.click(channel('Alpha (experimental)'));
    expect(setChannel).toHaveBeenCalledWith('alpha');
  });

  it('warns on alpha that the builds are experimental and a shared space needs the same alpha', () => {
    mockHook(status({ channel: 'alpha', latest: { version: '0.22.0-alpha.3', url: 'u', publishedAt: null } }));
    render(<AboutTab />);
    expect(channel('Alpha (experimental)').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(/Early builds for testing\. Things may break; your brain stays compatible only while everyone in a shared space runs the same alpha\./)).toBeTruthy();
    expect(screen.getByText(/Latest: v0\.22\.0-alpha\.3/)).toBeTruthy();
  });
});
