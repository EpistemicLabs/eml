import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { platformFor } from '../src/infrastructure/platform/index.js'

const SRC = join(__dirname, '..', 'src')
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const file = join(dir, name)
  return statSync(file).isDirectory() ? files(file) : file.endsWith('.ts') ? [file] : []
})

describe('platform', () => {
  it('is the only code that asks which OS it runs on', () => {
    const offenders = files(SRC)
      .filter((file) => !relative(SRC, file).startsWith(join('infrastructure', 'platform') + sep))
      .filter((file) => /process\.platform\b/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
      .map((file) => relative(SRC, file))
    expect(offenders).toEqual([])
  })

  it('names executables and release builds per OS', () => {
    expect(platformFor('darwin').exe('codex')).toBe('codex')
    expect(platformFor('win32').exe('codex')).toBe('codex.exe')
    expect(platformFor('win32').exe('codex.exe')).toBe('codex.exe')
    expect(platformFor('win32').runtimeKey()).toMatch(/^win32-(x64|arm64)$/)
    expect(platformFor('darwin').runtimeKey()).toMatch(/^darwin-(x64|arm64)$/)
    expect(() => platformFor('aix')).toThrow(/unsupported platform/)
  })
})
