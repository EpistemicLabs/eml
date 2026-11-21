// @vitest-environment jsdom
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readRelationColors, RELATION_TYPES } from './graph';

describe('relation colours from tokens', () => {
  it('reads every relation type from its --relation-* token on the graph element', () => {
    const el = document.createElement('div');
    RELATION_TYPES.forEach((r, i) => el.style.setProperty(`--relation-${r}`, `#00000${i}`));
    document.body.append(el);
    const colors = readRelationColors(el);
    RELATION_TYPES.forEach((r, i) => expect(colors[r]).toBe(`#00000${i}`));
  });

  it('has a token in index.css for every relation type, light and dark', () => {
    const css = readFileSync(join(import.meta.dirname, '..', 'index.css'), 'utf8');
    for (const r of RELATION_TYPES) expect(css.match(new RegExp(`--relation-${r}:`, 'g'))?.length, r).toBe(2);
  });
});
