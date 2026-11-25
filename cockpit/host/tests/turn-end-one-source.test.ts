import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

/**
 * Every text an agent reads about ending a turn is built in domain/turn-end.ts.
 * This fails when another host source file words one: a string that names the
 * end_turn tool or the older session_status, by its name or through the
 * constant, or that asks for the handoff block.
 *
 * Allowed everywhere: comments, the bare name as a value (the mark on a check's
 * job, a tool's name), and the constants passed on as they are (the tool's
 * registration in providers/claude/sdk-runtime.ts).
 */

const SRC = join(__dirname, '..', 'src')
const ONE_SOURCE = 'domain/turn-end.ts'

const NAMED = /end_turn|session_status|\$\{\s*(?:END_TURN_TOOL|LEGACY_STATUS_TOOL)\s*\}|### Handoff|[Hh]andoff block/
/** The name alone, as a value: no sentence around it. */
const BARE_NAME = /(['"`])(?:end_turn|session_status)\1/g

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name)
    return entry.isDirectory() ? sourceFiles(file) : entry.name.endsWith('.ts') ? [file] : []
  })
}

/** The code of a file without its comments: block comments, and line comments that are not part of a URL. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, '')).replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function wordings(source: string): string[] {
  return withoutComments(source).split('\n')
    .map((line, i) => ({ line: line.replace(BARE_NAME, ''), at: i + 1 }))
    .filter(({ line }) => NAMED.test(line))
    .map(({ line, at }) => `${at}: ${line.trim()}`)
}

describe('texts about ending a turn', () => {
  it('are worded only in domain/turn-end.ts', () => {
    const found = sourceFiles(SRC)
      .map((file) => ({ file: relative(SRC, file).split('\\').join('/'), source: readFileSync(file, 'utf8') }))
      .filter(({ file }) => file !== ONE_SOURCE)
      .flatMap(({ file, source }) => wordings(source).map((w) => `${file}:${w}`))
    expect(found).toEqual([])
  })

  it('finds a wording by the tool\'s name, by its constant and by the block, and lets comments and bare names pass', () => {
    expect(wordings('const a = \'Call end_turn now.\'')).toHaveLength(1)
    expect(wordings('const a = `Call ${END_TURN_TOOL} again.`')).toHaveLength(1)
    expect(wordings('const a = \'report with session_status if you have it\'')).toHaveLength(1)
    expect(wordings('const a = \'write your handoff block now\'')).toHaveLength(1)
    expect(wordings('// the end_turn call\n/** session_status,\n * the older one */\nconst origin = \'end_turn\'\ntool(END_TURN_TOOL, END_TURN_DESCRIPTION)')).toEqual([])
    // The one source itself is full of them.
    expect(wordings(readFileSync(join(SRC, ONE_SOURCE), 'utf8')).length).toBeGreaterThan(5)
  })
})
