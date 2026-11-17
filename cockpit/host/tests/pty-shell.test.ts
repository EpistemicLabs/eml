import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { WebSocket } from 'ws'
import { PtyBridge, type SpawnContext } from '../src/pty-bridge.js'
import { platform } from '../src/infrastructure/platform/index.js'

// The Shell plugin's terminal in the PTY bridge: it opens for a local client
// and for a remote one only when allowed, runs outside the agent sessions'
// count, ends when its pane is closed, and starts again on Enter after it
// exited. The "shell" here is node printing a line, so the test runs alike
// on every OS.

class FakeSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  sent: string[] = []
  closed: string | null = null
  send(data: string | Buffer) { this.sent.push(typeof data === 'string' ? data : data.subarray(1).toString('utf8')) }
  close(_code?: number, reason?: string) { this.closed = reason ?? ''; this.readyState = WebSocket.CLOSED }
  frame(message: Record<string, unknown>) { this.emit('message', Buffer.from(JSON.stringify(message)), false) }
  text() { return this.sent.join('') }
}

const bridges: PtyBridge[] = []
const bridge = (ctx: Partial<SpawnContext> = {}) => {
  const b = new PtyBridge({ ...ctx } as SpawnContext)
  bridges.push(b)
  return b
}
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 50))
  expect(check()).toBe(true)
}
const init = { type: 'init', kind: 'shell', sessionId: 'shell-1', paneId: 'pane-1', cols: 80, rows: 24 }

afterEach(() => {
  for (const b of bridges.splice(0)) b.dispose()
  vi.restoreAllMocks()
})

describe('shell', () => {
  it('runs the user\'s shell for a local client, outside the sessions\' count, until its pane closes', async () => {
    vi.spyOn(platform, 'userShell').mockReturnValue({ bin: process.execPath, args: ['-e', "console.log('hello from the shell'); setTimeout(() => {}, 10000)"] })
    const b = bridge()
    const ws = new FakeSocket()
    b.attach(ws as unknown as WebSocket, true)
    ws.frame(init)
    await until(() => ws.text().includes('hello from the shell'))
    expect(b.runningCount()).toBe(0)
    expect(b.processes().size).toBe(0)
    expect(b.endShell('shell-1')).toBe(true)
    expect(ws.closed).toBe('closed')
    expect(b.endShell('shell-1')).toBe(false)
  })

  it('refuses a remote client unless the context allows it, and says why', async () => {
    vi.spyOn(platform, 'userShell').mockReturnValue({ bin: process.execPath, args: ['-e', "console.log('hello')"] })
    const ws = new FakeSocket()
    bridge().attach(ws as unknown as WebSocket, false)
    ws.frame(init)
    await until(() => ws.text().includes('this machine only'))

    const off = new FakeSocket()
    bridge({ shellRefusal: async () => 'Shell is switched off' }).attach(off as unknown as WebSocket, true)
    off.frame(init)
    await until(() => off.text().includes('Shell is switched off'))
    expect(off.text()).not.toContain('hello')
  })

  it('takes the pane\'s size even when it changes while the shell is being opened', async () => {
    vi.spyOn(platform, 'userShell').mockReturnValue({ bin: process.execPath, args: ['-e', "setTimeout(() => console.log('cols=' + process.stdout.columns), 500); setTimeout(() => {}, 10000)"] })
    const ws = new FakeSocket()
    bridge().attach(ws as unknown as WebSocket, true)
    ws.frame({ ...init, cols: 140 })
    ws.frame({ type: 'resize', cols: 80, rows: 24 })
    await until(() => /cols=\d+/.test(ws.text()))
    expect(ws.text()).toContain('cols=80')
  })

  it('says when the shell exited and starts a new one on Enter', async () => {
    vi.spyOn(platform, 'userShell').mockReturnValue({ bin: process.execPath, args: ['-e', "console.log('run')"] })
    const ws = new FakeSocket()
    bridge().attach(ws as unknown as WebSocket, true)
    ws.frame(init)
    await until(() => ws.text().includes('press Enter for a new one'))
    ws.frame({ type: 'input', data: 'x' })
    ws.frame({ type: 'input', data: '\r' })
    await until(() => ws.text().split('run').length - 1 === 2)
  })
})
