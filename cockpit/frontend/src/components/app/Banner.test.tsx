// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Sparkles } from 'lucide-react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Banner } from './Banner';

// Every banner has a ×; dismissed, it stays away in this browser until what it says changes.

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

const banner = (key: string, text = 'Brain hygiene: 20 reviews are due') => (
  <Banner tone="info" icon={Sparkles} dismissKey={key}>{text}</Banner>
);

describe('Banner', () => {
  it('hides on ×, stays hidden after a reload, and shows again when its content changes', () => {
    const { rerender, unmount } = render(banner('hygiene:Main:20 reviews'));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/reviews are due/)).toBeNull();
    unmount();
    render(banner('hygiene:Main:20 reviews'));
    expect(screen.queryByText(/reviews are due/)).toBeNull();
    cleanup();
    const again = render(banner('hygiene:Main:21 reviews', 'Brain hygiene: 21 reviews are due'));
    expect(screen.getByText(/21 reviews are due/)).toBeTruthy();
    again.rerender(banner('hygiene:Main:20 reviews'));
    expect(screen.queryByText(/reviews are due/)).toBeNull();
    void rerender;
  });

  it('has no × without a key or a dismiss action', () => {
    render(<Banner tone="info" icon={Sparkles}>Plain</Banner>);
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});
