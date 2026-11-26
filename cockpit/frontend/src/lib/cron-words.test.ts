/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cronWords } from './task-board';

// cronWords is a port of the host's cronInWords (host src/domain/run-text.ts): a session and the page must say a
// repeating time in the same words. Both are held to one list, which the host's tests/run-text.test.ts reads too.
const FIXTURE = join(import.meta.dirname, '../../../host/tests/fixtures/cron-words.json');

describe('cronWords and the host\'s cronInWords', () => {
  it('give the same words for every cron of the shared list', () => {
    const { cases } = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { cases: Array<[string, string | null]> };
    expect(cases.length).toBeGreaterThan(30);
    expect(cases.map(([cron]) => [cron, cronWords(cron)])).toEqual(cases);
  });
});
