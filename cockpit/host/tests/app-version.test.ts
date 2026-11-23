import { describe, it, expect } from 'vitest'
import { compareVersions, isAppVersion, isPrerelease, isUpdateChannel, minorOf } from '../src/domain/app-version.js'

describe('app versions', () => {
  it('accepts X.Y.Z with an optional pre-release, nothing else', () => {
    for (const v of ['0.21.5', '0.22.0-alpha.1', '0.22.0-alpha.10', '1.0.0-rc.1', '1.0.0-0.3.7', '1.0.0-x-y.2']) expect(isAppVersion(v)).toBe(true)
    for (const v of ['', 'v0.21.5', '0.21', '0.21.5.1', '0.22.0-', '0.22.0-alpha..1', '0.22.0+build.1', '0.22.0-alpha_1', '../0.21.5', 7]) expect(isAppVersion(v)).toBe(false)
  })

  it('orders the release core numerically', () => {
    expect(compareVersions('0.18.10', '0.18.9')).toBeGreaterThan(0)
    expect(compareVersions('0.9.1', '0.18.0')).toBeLessThan(0)
    expect(compareVersions('0.21.5', '0.21.5')).toBe(0)
  })

  it('orders pre-releases by semver precedence', () => {
    expect(compareVersions('0.22.0-alpha.3', '0.22.0-alpha.10')).toBeLessThan(0)
    expect(compareVersions('0.22.0-alpha.10', '0.22.0')).toBeLessThan(0)
    expect(compareVersions('0.22.0', '0.22.0-alpha.10')).toBeGreaterThan(0)
    expect(compareVersions('0.22.0-alpha.1', '0.21.153')).toBeGreaterThan(0)
    expect(compareVersions('0.22.0-alpha.1', '0.22.0-alpha.1')).toBe(0)
    // numeric identifiers sort before alphanumeric ones; a longer set wins on an equal prefix
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-alpha.1')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha.beta', '1.0.0-beta')).toBeLessThan(0)
    const sorted = ['0.22.0', '0.22.0-alpha.10', '0.21.153', '0.22.0-alpha.3', '0.22.0-alpha.1'].sort(compareVersions)
    expect(sorted).toEqual(['0.21.153', '0.22.0-alpha.1', '0.22.0-alpha.3', '0.22.0-alpha.10', '0.22.0'])
  })

  it('takes the schema minor and the pre-release mark', () => {
    expect(minorOf('0.22.0-alpha.4')).toBe('0.22')
    expect(isPrerelease('0.22.0-alpha.4')).toBe(true)
    expect(isPrerelease('0.22.0')).toBe(false)
  })

  it('knows the two update channels', () => {
    expect(isUpdateChannel('stable')).toBe(true)
    expect(isUpdateChannel('alpha')).toBe(true)
    expect(isUpdateChannel('next')).toBe(false)
    expect(isUpdateChannel(undefined)).toBe(false)
  })
})
