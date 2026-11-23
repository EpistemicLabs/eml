import { describe, expect, it } from 'vitest';

import { cn } from './utils';

describe('cn', () => {
  it('keeps a size from the cockpit scale next to a text colour', () => {
    expect(cn('text-caption text-foreground')).toBe('text-caption text-foreground');
    expect(cn('text-ui text-muted-foreground')).toBe('text-ui text-muted-foreground');
    expect(cn('text-body', 'text-primary')).toBe('text-body text-primary');
    expect(cn('text-heading text-warning')).toBe('text-heading text-warning');
  });

  it('knows the v2 sizes too (chat, title, display)', () => {
    expect(cn('text-chat text-foreground')).toBe('text-chat text-foreground');
    expect(cn('text-title text-muted-foreground')).toBe('text-title text-muted-foreground');
    expect(cn('text-display', 'text-you-ink')).toBe('text-display text-you-ink');
    expect(cn('text-title', 'text-body')).toBe('text-body');
  });

  it('still lets a later size replace an earlier one', () => {
    expect(cn('text-caption', 'text-ui')).toBe('text-ui');
    expect(cn('text-caption', 'text-xs')).toBe('text-xs');
    expect(cn('text-xs', 'text-body')).toBe('text-body');
  });

  it('still lets a later colour replace an earlier one', () => {
    expect(cn('text-caption text-foreground', 'text-muted-foreground')).toBe('text-caption text-muted-foreground');
  });

  it('lets a width or shadow from the scale replace a token one, and the other way round', () => {
    expect(cn('max-w-dialog', 'max-w-4xl')).toBe('max-w-4xl');
    expect(cn('max-w-4xl', 'max-w-sheet')).toBe('max-w-sheet');
    expect(cn('shadow-modal', 'shadow-overlay')).toBe('shadow-overlay');
  });
});
