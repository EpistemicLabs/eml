import { describe, expect, it } from 'vitest';

import { cellNumber, guessDelimiter, nextSort, parseCsv, toTable, viewRows } from './csv';
import { extractFileRefs, formatSize, typeLabel } from './file-refs';
import { closeMedia, getMediaOpen, openMedia, showMediaAt, stepMedia, type FileInfo } from './files';

describe('csv', () => {
  it('parses quoted fields with delimiters, quotes and line breaks', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\n"multi\nline",2\r\n', ',')).toEqual([['a', 'b'], ['x, y', 'say "hi"'], ['multi\nline', '2']]);
  });

  it('guesses the delimiter from the first line', () => {
    expect(guessDelimiter('a;b;c\n1;2;3', false)).toBe(';');
    expect(guessDelimiter('a\tb\n1\t2', false)).toBe('\t');
    expect(guessDelimiter('single', false)).toBe(',');
    expect(guessDelimiter('a,b', true)).toBe('\t');
  });

  it('reads numbers with thousands separators and percent signs', () => {
    expect(cellNumber('1,234.5')).toBe(1234.5);
    expect(cellNumber('12%')).toBe(12);
    expect(cellNumber('2026-10-12')).toBeNull();
    expect(cellNumber('')).toBeNull();
  });

  it('sorts numeric columns by value and filters by every word', () => {
    const table = toTable('Week,Group,Sessions\n2026-10-12,Control,4212\n2026-10-12,AI chat,16880\n2026-10-19,Control,980\n', false);
    expect(table.numeric).toEqual([false, false, true]);
    expect(viewRows(table, { filter: '', sort: { column: 2, dir: 1 } }).map((r) => r[2])).toEqual(['980', '4212', '16880']);
    expect(viewRows(table, { filter: 'control 10-19', sort: null })).toEqual([['2026-10-19', 'Control', '980']]);
  });

  it('cycles a header through ascending, descending and the file order', () => {
    expect(nextSort(null, 1)).toEqual({ column: 1, dir: 1 });
    expect(nextSort({ column: 1, dir: 1 }, 1)).toEqual({ column: 1, dir: -1 });
    expect(nextSort({ column: 1, dir: -1 }, 1)).toBeNull();
    expect(nextSort({ column: 1, dir: -1 }, 0)).toEqual({ column: 0, dir: 1 });
  });
});

describe('file refs', () => {
  it('reads the same paths as the host', () => {
    expect(extractFileRefs('Done: `/a b/c.md`, /tmp/x.csv and https://x.io/y.png')).toEqual(['/a b/c.md', '/tmp/x.csv']);
  });

  it('labels and sizes', () => {
    expect(typeLabel('/a/b.JPEG')).toBe('jpg');
    expect(typeLabel('/a/b.markdown')).toBe('md');
    expect(formatSize(840)).toBe('840 B');
    expect(formatSize(1229)).toBe('1.2 KB');
    expect(formatSize(2.4 * 1024 * 1024)).toBe('2.4 MB');
  });
});

describe('the slide-over state', () => {
  const file = (name: string): FileInfo => ({ ref: name, path: `/w/${name}`, name, kind: 'csv', size: 1, modifiedAt: '' });

  it('opens at a clamped index, flips within the files, stops at the ends and closes', () => {
    openMedia({ files: [file('a.csv'), file('b.csv')], index: 5, chat: null });
    expect(getMediaOpen()?.index).toBe(1);
    stepMedia(1);
    expect(getMediaOpen()?.index).toBe(1);
    stepMedia(-1);
    stepMedia(-1);
    expect(getMediaOpen()?.index).toBe(0);
    showMediaAt(7);
    expect(getMediaOpen()?.index).toBe(0);
    showMediaAt(1);
    expect(getMediaOpen()?.index).toBe(1);
    closeMedia();
    expect(getMediaOpen()).toBeNull();
  });
});
