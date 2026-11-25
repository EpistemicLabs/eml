// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

import { setTimeZoneForTest, userTimeZone } from '@/lib/time-zone';

import TimeZoneSection from './TimeZoneSection';

afterEach(() => { cleanup(); setTimeZoneForTest(null); vi.unstubAllGlobals(); });

describe('Settings › Your time zone', () => {
  it('offers the browser\'s zone when it differs from the saved one, and switches only on the click (the tests run in UTC)', async () => {
    setTimeZoneForTest('Asia/Bangkok');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ timeZone: 'UTC' })));
    vi.stubGlobal('fetch', fetcher);
    render(<TimeZoneSection />);
    expect((screen.getByLabelText('Your time zone') as HTMLSelectElement).value).toBe('Asia/Bangkok');
    expect(screen.getByText(/Times stay in Asia\/Bangkok until you switch/)).toBeTruthy();
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Switch to UTC' })); });
    expect(fetcher).toHaveBeenCalledWith('/api/jobs/time-zone', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ timeZone: 'UTC', explicit: true }) }));
    expect(userTimeZone()).toBe('UTC');
    expect(screen.queryByRole('button', { name: /Switch to/ })).toBeNull();
  });
});
