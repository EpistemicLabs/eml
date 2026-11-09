// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as push from '@/lib/push';
import NotificationsSection from './NotificationsSection';

// Settings › Notifications: turning push on for this device, its test, and what it says when that does not work.

vi.mock('@/lib/push', () => ({
  currentPushSupport: vi.fn(),
  pushEnabled: vi.fn(),
  enablePush: vi.fn(),
  disablePush: vi.fn(),
  sendTestPush: vi.fn(),
}));

const mocked = vi.mocked(push);
const toggle = () => screen.getByRole('switch', { name: 'Notifications on this device' });

beforeEach(() => {
  mocked.currentPushSupport.mockReturnValue('supported');
  mocked.pushEnabled.mockResolvedValue(false);
  mocked.enablePush.mockResolvedValue('enabled');
  mocked.disablePush.mockResolvedValue(undefined);
  mocked.sendTestPush.mockResolvedValue('sent');
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('NotificationsSection', () => {
  it('asks for the home screen on an iPhone outside the home-screen app, and cannot be switched there', () => {
    mocked.currentPushSupport.mockReturnValue('home-screen');
    render(<NotificationsSection />);
    expect(screen.getByText(/add the cockpit to the home screen/)).toBeTruthy();
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
  });

  it('turns push on, then offers a test', async () => {
    render(<NotificationsSection />);
    expect(screen.queryByText('Send test')).toBeNull();
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText('Send test')).toBeTruthy());
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByText('Send test'));
    await waitFor(() => expect(screen.getByText(/Test sent/)).toBeTruthy());
  });

  it('stays off with the reason when the permission is blocked', async () => {
    mocked.enablePush.mockResolvedValue('denied');
    render(<NotificationsSection />);
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(/Blocked/)).toBeTruthy());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('shows the state the device is in, and turns off when a test finds the subscription gone', async () => {
    mocked.pushEnabled.mockResolvedValue(true);
    mocked.sendTestPush.mockResolvedValue('gone');
    render(<NotificationsSection />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(screen.getByText('Send test'));
    await waitFor(() => expect(screen.getByText(/no longer subscribed/)).toBeTruthy());
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('turns push off on this device', async () => {
    mocked.pushEnabled.mockResolvedValue(true);
    render(<NotificationsSection />);
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().getAttribute('aria-checked')).toBe('false'));
    expect(mocked.disablePush).toHaveBeenCalled();
  });
});
