import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { platform, platformFor } from '../src/infrastructure/platform/index.js'

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
  it('switches a directory link to another directory, on this OS', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cockpit-platform-link-'))
    try {
      for (const v of ['1', '2']) {
        mkdirSync(join(dir, 'versions', v), { recursive: true })
        writeFileSync(join(dir, 'versions', v, 'id'), v)
      }
      const link = join(dir, 'current')
      platform.switchDirLink(join(dir, 'versions', '1'), link)
      expect(readFileSync(join(link, 'id'), 'utf8')).toBe('1')
      platform.switchDirLink(join(dir, 'versions', '2'), link)
      expect(readFileSync(join(link, 'id'), 'utf8')).toBe('2')
      // The old target is untouched, and nothing temporary is left beside the link.
      expect(readFileSync(join(dir, 'versions', '1', 'id'), 'utf8')).toBe('1')
      expect(readdirSync(dir).sort()).toEqual(['current', 'versions'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('gives a downloaded binary on Windows what it needs to start, from the system folder', () => {
    const env = platformFor('win32').minimalEnv()
    expect(env.PATH).toMatch(/System32/)
    expect(platformFor('darwin').minimalEnv().PATH).toBe('/usr/bin:/bin')
    expect(platformFor('win32').linksFiles).toBe(false)
  })
})
