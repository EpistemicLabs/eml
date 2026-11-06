import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import './setup-home.js'
import { DEFAULT_LIMITS, idleMs, readLimits, sessionLimits, writeLimits } from '../src/session-limits.js'

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'limits-')), 'limits.json')

describe('session limits', () => {
  it('without a file: 2 GB per session, one idle hour, eight running', () => {
    expect(readLimits(file())).toEqual({ memoryGb: 2, idleHours: 1, maxRunning: 8 })
  })

  it('keeps what was set and defaults the rest', () => {
    const f = file()
    expect(writeLimits({ memoryGb: 4 }, f)).toEqual({ ...DEFAULT_LIMITS, memoryGb: 4 })
    expect(readLimits(f).memoryGb).toBe(4)
  })

  it('refuses a value out of range or a setting it does not know', () => {
    const f = file()
    expect(typeof writeLimits({ idleHours: 0 }, f)).toBe('string')
    expect(typeof writeLimits({ maxRunning: 2.5 }, f)).toBe('string')
    expect(typeof writeLimits({ other: 1 }, f)).toBe('string')
    expect(readLimits(f)).toEqual(DEFAULT_LIMITS)
  })

  it('a stored value out of range falls back to its default', () => {
    const f = file()
    fs.writeFileSync(f, JSON.stringify({ memoryGb: -1, idleHours: 'x', maxRunning: 3 }))
    expect(readLimits(f)).toEqual({ ...DEFAULT_LIMITS, maxRunning: 3 })
  })

  it('0 GB is no ceiling; the swap on top is fixed', () => {
    expect(sessionLimits({ ...DEFAULT_LIMITS, memoryGb: 0 }).memoryBytes).toBeNull()
    expect(sessionLimits(DEFAULT_LIMITS)).toEqual({ memoryBytes: 2 * 1024 ** 3, swapBytes: 512 * 1024 ** 2 })
    expect(idleMs({ ...DEFAULT_LIMITS, idleHours: 1.5 })).toBe(90 * 60 * 1000)
  })
})
