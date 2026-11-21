/// <reference types="node" />
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Design tokens v2: every number a component needs comes from a token in index.css.
// Existing literals are counted per file in design-tokens.baseline.json and may only go down;
// v2 surfaces start at zero. UPDATE_TOKEN_BASELINE=1 rewrites the baseline after a cleanup.

const SRC = import.meta.dirname;
const CSS = readFileSync(join(SRC, 'index.css'), 'utf8');
const BASELINE_FILE = join(SRC, 'design-tokens.baseline.json');

/** Directories built on tokens v2: no literal values at all. */
const V2_DIRS = ['components/task-board', 'components/top-bar', 'components/session-launcher', 'shared/view/ui'];
/** Files that may hold colour literals, and why. */
const COLOUR_EXCEPTIONS: Record<string, string> = {
  'lib/graph.ts': 'canvas drawing reads concrete colours',
  'components/graph/nodes.tsx': 'graph node colours are computed per engram type',
  'components/shell/utils/terminalTheme.ts': 'xterm takes a concrete colour theme',
};
const MIX_STEPS = new Set(['8', '10', '12', '20', '40', '60']);

function sourceFiles(dir = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e): string[] => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : sourceFiles(p);
    return /\.(tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** The body of the first block whose selector line matches. */
function block(selector: RegExp): string {
  const m = selector.exec(CSS);
  if (!m) return '';
  let depth = 0;
  const start = CSS.indexOf('{', m.index);
  for (let i = start; i < CSS.length; i++) {
    if (CSS[i] === '{') depth++;
    if (CSS[i] === '}' && --depth === 0) return CSS.slice(start + 1, i);
  }
  return '';
}

function props(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}

const THEME = props(block(/^@theme \{/m));
const SCOPE_LIGHT = props(block(/^\[data-ui="v2"\] \{/m));
const SCOPE_DARK = props(block(/^\.dark \[data-ui="v2"\], \[data-ui="v2"\]\.dark \{/m));

// ---- WCAG contrast, the same formula as review-ui-ux/scripts/contrast.py ----
type Rgb = [number, number, number];
const hex = (h: string): Rgb => {
  const x = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16)) as Rgb;
};
const mix = (a: Rgb, b: Rgb, p: number): Rgb => a.map((v, i) => v * p + b[i] * (1 - p)) as Rgb;
const lum = (c: Rgb) => {
  const ch = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
};
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function palette(dark: boolean) {
  const get = (name: string): Rgb => {
    const v = (dark && SCOPE_DARK.get(name)) || SCOPE_LIGHT.get(name) || THEME.get(name);
    if (!v || !v.startsWith('#')) throw new Error(`${name} has no hex value in the v2 scope (${v})`);
    return hex(v);
  };
  return get;
}

const HUES = ['you', 'stopped', 'review', 'agent', 'scheduled', 'waiting', 'done'];
const INK_MIX = Number.parseFloat(props(block(/^:root \{\n\s*--mix-/m)).get('--mix-ink') ?? 'NaN') / 100;

describe('tokens v2 contrast', () => {
  for (const dark of [false, true]) {
    const c = palette(dark);
    const theme = dark ? 'dark' : 'light';

    it(`keeps text at 4.5:1 on every v2 surface (${theme})`, () => {
      const failures: string[] = [];
      const check = (label: string, fg: Rgb, bg: Rgb, min = 4.5) => {
        const r = ratio(fg, bg);
        if (r < min) failures.push(`${label} ${r.toFixed(2)}:1`);
      };
      const surfaces = ['--color-background', '--color-card', '--color-muted'];
      for (const s of surfaces) {
        check(`foreground on ${s}`, c('--color-foreground'), c(s));
        check(`muted-foreground on ${s}`, c('--color-muted-foreground'), c(s));
        check(`border-strong on ${s}`, c('--color-border-strong'), c(s), 3);
      }
      check('background on foreground (primary)', c('--color-background'), c('--color-foreground'));
      check('white on person-2', hex('#ffffff'), c('--color-person-2'));
      const hues = [...HUES.map((h) => `--color-status-${h}`), '--color-mark'];
      for (const h of hues) {
        const ink = mix(c(h), c('--color-foreground'), INK_MIX);
        for (const step of MIX_STEPS) {
          if (Number(step) > 20) continue; // 40 and 60 are edges and glows, never under text
          check(`${h} ink on ${step}% tint`, ink, mix(c(h), c('--color-card'), Number(step) / 100));
        }
        for (const s of surfaces) check(`${h} ink on ${s}`, ink, c(s));
      }
      expect(failures).toEqual([]);
    });
  }

  it('mixes the ink tokens from their hue and the text colour', () => {
    expect(INK_MIX).toBeGreaterThan(0);
    for (const h of [...HUES, 'mark']) {
      const name = h === 'mark' ? '--color-mark-ink' : `--color-${h}-ink`;
      const source = h === 'mark' ? '--color-mark' : `--color-status-${h}`;
      expect(SCOPE_LIGHT.get(name), name).toBe(
        `color-mix(in srgb, var(${source}) var(--mix-ink), var(--color-foreground))`,
      );
    }
  });
});

describe('tokens v2 scope', () => {
  it('re-declares every colour token built from another token', () => {
    // A custom property that uses var() is computed where it is declared, so an alias declared only
    // on :root keeps its v1 value inside the scope.
    const missing = [...THEME]
      .filter(([name, value]) => name.startsWith('--color-') && value.includes('var('))
      .map(([name]) => name)
      .filter((name) => !SCOPE_LIGHT.has(name));
    expect(missing).toEqual([]);
  });

  it('gives every hue and neutral a dark value', () => {
    const needDark = [...SCOPE_LIGHT.keys(), ...THEME.keys()].filter(
      (n) => /^--color-(status-|mark$|background|card$|muted|foreground|border|ring)/.test(n)
        && !(SCOPE_LIGHT.get(n) ?? THEME.get(n) ?? '').includes('var('),
    );
    expect(needDark.filter((n) => !SCOPE_DARK.has(n))).toEqual([]);
  });
});

// ---- literal values: a ratchet over existing code, zero in v2 directories ----
// A literal in brackets: starting with a number, colour or calc, or holding a number with a unit anywhere (inset_2px_…).
const ARBITRARY = /\b[\w:-]+-\[(?:\d|#|rgb|hsl|calc\(\s*\d|[^\]]*?\d(?:px|rem|em|ms|s|vh|vw|dvh|%|deg)\b)[^\]]*\]|\/\[\d?\.?\d+\]/g;
const COLOUR = /#[0-9a-fA-F]{3,8}\b(?![\w-])|\brgba?\(|\bhsla?\(/g;
// v2 uses one font, the UI font with tabular figures for numbers; code keeps the cockpit's monospace.
const RAW_SCALE = /\b(?:text-(?:xs|sm|base|lg|xl)|z-\d+|font-(?:data|mono))\b/g;
const OPACITY = /\b(?:bg|text|border|ring|outline|fill|stroke|shadow|from|to|via)-[\w-]+\/(\d+)\b/g;

function count(re: RegExp, text: string) {
  return [...text.matchAll(re)].length;
}

/** Lines of index.css outside the token blocks and the two glass utilities that hold a literal. */
function cssLiterals(): number {
  const allowed = [/^@theme \{/m, /^:root \{/gm, /^html\.dark \{/gm, /^\[data-ui="v2"\] \{/m, /^\.dark \[data-ui="v2"\]/m, /^@utility glass \{/m, /^@utility glass-thick \{/m];
  let rest = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const re of allowed) {
    for (const m of [...rest.matchAll(new RegExp(re.source, 'gm'))].reverse()) {
      const start = rest.indexOf('{', m.index);
      let depth = 0;
      for (let i = start; i < rest.length; i++) {
        if (rest[i] === '{') depth++;
        if (rest[i] === '}' && --depth === 0) { rest = rest.slice(0, m.index) + rest.slice(i + 1); break; }
      }
    }
  }
  return rest.split('\n').filter((l: string) => /\d+(?:px|ms|s)\b|#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(l)).length;
}

function measure(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const file of sourceFiles()) {
    const rel = relative(SRC, file);
    const text = readFileSync(file, 'utf8');
    let n = count(ARBITRARY, text);
    if (!(rel in COLOUR_EXCEPTIONS)) n += count(COLOUR, text);
    if (n) out[rel] = n;
  }
  const css = cssLiterals();
  if (css) out['index.css'] = css;
  return out;
}

describe('no magic numbers', () => {
  const now = measure();

  it('never raises a file above its baseline', () => {
    if (process.env.UPDATE_TOKEN_BASELINE) {
      writeFileSync(BASELINE_FILE, JSON.stringify(now, Object.keys(now).sort(), 2) + '\n');
      return;
    }
    const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    const over = Object.entries(now)
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} literal values, baseline ${baseline[f] ?? 0}`);
    expect(over).toEqual([]);
  });

  it('keeps the baseline tight (run with UPDATE_TOKEN_BASELINE=1 after a cleanup)', () => {
    if (process.env.UPDATE_TOKEN_BASELINE) return;
    const baseline: Record<string, number> = JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
    const stale = Object.entries(baseline)
      .filter(([f, n]) => (now[f] ?? 0) < n)
      .map(([f, n]) => `${f}: baseline ${n}, now ${now[f] ?? 0}`);
    expect(stale).toEqual([]);
  });

  it('allows no literal, raw scale step or off-scale opacity in v2 directories', () => {
    const found: string[] = [];
    for (const file of sourceFiles()) {
      const rel = relative(SRC, file);
      if (!V2_DIRS.some((d) => rel.startsWith(d + '/'))) continue;
      const text = readFileSync(file, 'utf8');
      for (const re of [ARBITRARY, COLOUR, RAW_SCALE]) for (const m of text.matchAll(re)) found.push(`${rel}: ${m[0]}`);
      for (const m of text.matchAll(OPACITY)) if (!MIX_STEPS.has(m[1])) found.push(`${rel}: ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});
