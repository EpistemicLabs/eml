import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { watchMouseEncoding } from '../src/pty-bridge.js'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless') as typeof import('@xterm/headless')
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize')

const write = (terminal: InstanceType<typeof Terminal>, data: string) => new Promise<void>((resolve) => terminal.write(data, resolve))

describe('mouse encoding on reattach', () => {
  it('is recorded beside the snapshot, which leaves it out', async () => {
    const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
    const serialize = new SerializeAddon()
    terminal.loadAddon(serialize as never)
    const mouse = watchMouseEncoding(terminal)

    // What Qwen Code sends at start: alternate screen, drag tracking, SGR reports.
    await write(terminal, '\x1b[?1049h\x1b[?1002h\x1b[?1006hhello')
    expect(serialize.serialize()).toContain('\x1b[?1002h')
    expect(serialize.serialize()).not.toContain('\x1b[?1006h')
    expect(mouse.encoding).toBe('\x1b[?1006h')
    expect(terminal.modes.mouseTrackingMode).toBe('drag')

    await write(terminal, '\x1b[?1006l')
    expect(mouse.encoding).toBe('')
    // Several modes in one sequence, as a program may reset them together.
    await write(terminal, '\x1b[?1002;1015h')
    expect(mouse.encoding).toBe('\x1b[?1015h')
    terminal.dispose()
  })
})
