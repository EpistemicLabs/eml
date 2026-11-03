import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readConfig, parseConfig } from '../src/config'

describe('client config', () => {
  let dir: string
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eml-config-test-')) })
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

  it('readConfig returns null when the file is missing', () => {
    expect(readConfig(path.join(dir, 'config'))).toBeNull()
  })

  it('readConfig ignores comments and blank lines', () => {
    const file = path.join(dir, 'config')
    fs.writeFileSync(file, '# top comment\n\nEML_URL=https://x\n# inline\nEML_API_TOKEN=t\n\n')
    expect(readConfig(file)).toEqual({ EML_URL: 'https://x', EML_API_TOKEN: 't' })
  })

  it('parseConfig keeps only known keys and never evaluates values', () => {
    // EML_CLIENT_VERSION fed the npm-era update banner; since the cockpit
    // updates the app as a whole it is an unknown key like any other.
    expect(parseConfig('EML_URL=$(rm -rf /)\nPATH=/evil\nEML_CLIENT_VERSION=0.16.0\nnot a line')).toEqual({
      EML_URL: '$(rm -rf /)',
    })
  })

  it('parseConfig keeps the agent the embedding app names', () => {
    expect(parseConfig('EML_URL=u\nEML_API_TOKEN=t\nEML_AGENT=helper\n').EML_AGENT).toBe('helper')
  })
})
