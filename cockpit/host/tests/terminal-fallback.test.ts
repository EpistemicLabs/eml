import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'

// paths.ts reads the home at import time — set it before loading the modules.
const home = mkdtempSync(join(tmpdir(), 'cockpit-terminal-fallback-test-'))
process.env.EML_COCKPIT_HOME = home

const { readTerminalFallback, writeTerminalFallback, TERMINAL_FALLBACK_OFF } = await import('../src/terminal-fallback.js')
const { PtyBridge } = await import('../src/pty-bridge.js')
const { platform } = await import('../src/infrastructure/platform/index.js')
type SpawnContext = import('../src/pty-bridge.js').SpawnContext

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  sent: string[] = []
  send(data: string | Buffer) { this.sent.push(typeof data === 'string' ? data : data.subarray(1).toString('utf8')) }
  close() { this.readyState = WebSocket.CLOSED }
  frame(message: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify(message)), false) }
  text() { return this.sent.join('') }
  json() { return this.sent.flatMap((line) => { try { return [JSON.parse(line) as Record<string, unknown>] } catch { return [] } }) }
}

const bridges: InstanceType<typeof PtyBridge>[] = []
const bridge = (ctx: Partial<SpawnContext>) => {
  const b = new PtyBridge(ctx as SpawnContext)
  bridges.push(b)
  return b
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  expect(check()).toBe(true)
}

afterEach(() => {
  for (const b of bridges.splice(0)) b.dispose()
  vi.restoreAllMocks()
})
afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('the terminal fallback setting', () => {
  it('is off by default, and kept in agents.json once switched', () => {
    expect(readTerminalFallback()).toEqual({ enabled: false })
    expect(writeTerminalFallback({ enabled: true })).toEqual({ enabled: true })
    expect(readTerminalFallback()).toEqual({ enabled: true })
    expect(JSON.parse(readFileSync(join(home, 'agents.json'), 'utf8')).terminalFallback).toBe(true)
    expect(writeTerminalFallback({ enabled: false })).toEqual({ enabled: false })
    expect(readTerminalFallback()).toEqual({ enabled: false })
  })

  it('refuses what is not a boolean, and changes nothing then', () => {
    for (const body of [{ enabled: 'yes' }, { enabled: 1 }, {}, null, 'true']) {
      expect(writeTerminalFallback(body)).toBe('enabled must be true or false')
    }
    expect(readTerminalFallback()).toEqual({ enabled: false })
  })
})

describe('the PTY bridge with the fallback off', () => {
  it('refuses an agent session\'s terminal with TERMINAL_FALLBACK_OFF and where to turn it on', () => {
    const ws = new FakeSocket()
    bridge({ terminalFallback: () => false }).attach(ws as unknown as WebSocket, true)
    ws.frame({ type: 'init', sessionId: 'session-1', paneId: 'pane-1', projectId: 'bp-eml', cols: 80, rows: 24 })
    expect(ws.json()).toEqual([{
      type: 'error', code: TERMINAL_FALLBACK_OFF,
      message: 'Sessions run in the chat. To open one in a terminal, turn on Settings › Advanced › Terminal fallback.',
    }])
  })

  it('lets an agent session through once it is on (the next check is the space)', () => {
    const ws = new FakeSocket()
    bridge({ terminalFallback: () => true, spaces: { get: () => undefined, main: undefined } as never }).attach(ws as unknown as WebSocket, true)
    ws.frame({ type: 'init', sessionId: 'session-1', paneId: 'pane-1', projectId: 'bp-eml', spaceId: 'gone', cols: 80, rows: 24 })
    expect(ws.json()).toEqual([{ type: 'error', message: 'This desk belongs to a brain space this cockpit no longer has' }])
  })

  it('still opens the Shell plugin\'s terminal: the user\'s own shell is not an agent session', async () => {
    vi.spyOn(platform, 'userShell').mockReturnValue({ bin: process.execPath, args: ['-e', "console.log('hello from the shell'); setTimeout(() => {}, 10000)"] })
    const ws = new FakeSocket()
    bridge({ terminalFallback: () => false }).attach(ws as unknown as WebSocket, true)
    ws.frame({ type: 'init', kind: 'shell', sessionId: 'shell-1', paneId: 'pane-1', cols: 80, rows: 24 })
    await until(() => ws.text().includes('hello from the shell'))
    expect(ws.text()).not.toContain(TERMINAL_FALLBACK_OFF)
  })
})
