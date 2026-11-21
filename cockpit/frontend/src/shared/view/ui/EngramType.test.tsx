// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { ReviewFlag, TypeBadge, TypeDot, TypeToggle, typeColor } from './EngramType';

afterEach(cleanup);

describe('engram type in tokens v2', () => {
  it('takes the colour from the type token', () => {
    expect(typeColor('decision')).toBe('var(--type-decision)');
  });

  it('shows the hue only as a dot; the label stays monochrome', () => {
    render(<TypeBadge type="rule" />);
    const badge = screen.getByText('rule');
    expect(badge.className).toContain('text-foreground');
    expect(badge.getAttribute('style')).toBeNull();
    const dot = badge.querySelector('[aria-hidden]') as HTMLElement;
    expect(dot.style.backgroundColor).toBe('var(--type-rule)');
  });

  it('keeps the dot out of the accessibility tree', () => {
    const { container } = render(<TypeDot type="task" />);
    expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reports a filter chip as pressed and passes the click on', () => {
    const onClick = vi.fn();
    render(<TypeToggle type="note" on={false} onClick={onClick} />);
    const chip = screen.getByRole('button', { name: 'note' });
    expect(chip.getAttribute('aria-pressed')).toBe('false');
    expect(chip.className).toContain('min-h-(--target-min)');
    fireEvent.click(chip, { shiftKey: true });
    expect(onClick).toHaveBeenCalledOnce();
    expect(onClick.mock.calls[0][0].shiftKey).toBe(true);
  });

  it('marks a review flag in the needs-you amber', () => {
    render(<ReviewFlag />);
    expect(screen.getByText('review').className).toContain('text-you-ink');
  });
});
