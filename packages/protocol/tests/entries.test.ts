import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'

// v0.21 (block 3): two entry points. Core takes only the log format from
// @engramprotocol/protocol/log, so nothing behind that entry may load the
// crypto library; the main entry adds the rest.

const SRC = join(__dirname, '..', 'src')

/** Every module `file` reaches through its imports, with the outside modules it names. */
function reach(file: string, seen = new Set<string>(), outside = new Set<string>()): { seen: Set<string>, outside: Set<string> } {
  if (seen.has(file)) return { seen, outside }
  seen.add(file)
  for (const [, spec] of readFileSync(join(SRC, file), 'utf-8').matchAll(/from '([^']+)'/g)) {
    if (spec.startsWith('./')) reach(`${spec.slice(2)}.ts`, seen, outside)
    else outside.add(spec)
  }
  return { seen, outside }
}

describe('entry points', () => {
  it('/log reaches only the log format and node builtins, no crypto library', () => {
    const { seen, outside } = reach('log.ts')
    expect([...seen].sort()).toEqual(['canonical.ts', 'log.ts', 'op.ts'])
    expect([...outside]).toEqual(['crypto'])
  })

  it('the main entry includes everything /log exports', async () => {
    const main = await import('../src')
    const log = await import('../src/log')
    for (const name of Object.keys(log)) expect(main).toHaveProperty(name)
  })
})
