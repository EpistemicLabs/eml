// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { ReviewFlag, TypeBadge } from './badge';

afterEach(cleanup);

describe('TypeBadge', () => {
  it('shows the type in monochrome text with its hue only as a dot', () => {
    render(<TypeBadge type="decision" />);
    const badge = screen.getByText('decision');
    expect(badge.className).toContain('text-muted-foreground');
    expect(badge.getAttribute('style')).toBeNull();
    const dot = badge.querySelector('[aria-hidden]') as HTMLElement;
    expect(dot.style.backgroundColor).toBe('var(--type-decision)');
  });
});

describe('ReviewFlag', () => {
  it('carries the amber of "needs you"', () => {
    render(<ReviewFlag />);
    expect(screen.getByText('review').className).toContain('text-you-ink');
  });
});
