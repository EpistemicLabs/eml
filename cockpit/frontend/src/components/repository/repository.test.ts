import { describe, expect, it } from 'vitest';

import { parsePatch } from './DiffList';
import { fuzzyScore } from './FilesTab';

// The repository view's own parsing: a unified patch into numbered lines, and
// the file search's ranking.

describe('parsePatch', () => {
  it('numbers both sides from each hunk on and leaves the headers out', () => {
    const patch = [
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -3,3 +3,3 @@ function f() {',
      ' keep',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '@@ -10 +10,2 @@',
      ' tail',
      '+added',
      '',
    ].join('\n');
    expect(parsePatch(patch)).toEqual([
      { kind: 'hunk', text: 'function f() {', oldNo: null, newNo: null },
      { kind: 'context', text: 'keep', oldNo: 3, newNo: 3 },
      { kind: 'removed', text: 'old', oldNo: 4, newNo: null },
      { kind: 'added', text: 'new', oldNo: null, newNo: 4 },
      { kind: 'hunk', text: '', oldNo: null, newNo: null },
      { kind: 'context', text: 'tail', oldNo: 10, newNo: 10 },
      { kind: 'added', text: 'added', oldNo: null, newNo: 11 },
    ]);
  });

  it('finds no lines in a binary patch', () => {
    expect(parsePatch('diff --git a/x.png b/x.png\nBinary files a/x.png and b/x.png differ\n')).toEqual([]);
  });
});

describe('fuzzyScore', () => {
  it('matches a subsequence and ranks the file name over the folders', () => {
    expect(fuzzyScore('xyz', 'src/app.ts')).toBeNull();
    const name = fuzzyScore('pane', 'src/RepositoryPane.tsx')!;
    const folders = fuzzyScore('pane', 'src/pane/a/n/e.ts')!;
    expect(name).toBeGreaterThan(folders);
    expect(fuzzyScore('rp', 'src/RepositoryPane.tsx')).not.toBeNull();
  });
});
