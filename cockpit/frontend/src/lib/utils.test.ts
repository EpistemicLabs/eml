import { describe, expect, it } from 'vitest';

import { cn } from './utils';

describe('cn', () => {
  it('keeps a size from the cockpit scale next to a text colour', () => {
    expect(cn('text-caption text-foreground')).toBe('text-caption text-foreground');
    expect(cn('text-ui text-muted-foreground')).toBe('text-ui text-muted-foreground');
    expect(cn('text-body', 'text-primary')).toBe('text-body text-primary');
    expect(cn('text-heading text-warning')).toBe('text-heading text-warning');
  });

  it('still lets a later size replace an earlier one', () => {
    expect(cn('text-caption', 'text-ui')).toBe('text-ui');
    expect(cn('text-caption', 'text-xs')).toBe('text-xs');
    expect(cn('text-xs', 'text-body')).toBe('text-body');
  });

  it('still lets a later colour replace an earlier one', () => {
    expect(cn('text-caption text-foreground', 'text-muted-foreground')).toBe('text-caption text-muted-foreground');
  });
});
