import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { SessionSpace } from '../src/domain/agent-provider.js'
import { ClaudeSignIn, loginEnv, type LoginProcess } from '../src/infrastructure/providers/claude/sign-in.js'

/**
 * `claude auth login` driven by the host, against a process that is none: what the
 * CLI would print is pushed into its stdout by hand, what the host writes to its
 * stdin is read here. All codes are made up.
 */

const LINK = 'https://claude.example/oauth/authorize?code=true&state=fake'

class FakeLogin extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  written = ''
  killed = false
  stdin = Object.assign(new EventEmitter(), {
    write: (chunk: string) => { this.written += chunk },
    end: () => {},
  })

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('exit', null))
    return true
  }

  printLink(): void {
    this.stdout.emit('data', Buffer.from('Opening browser to sign in…\n'))
    this.stdout.emit('data', Buffer.from(`If the browser didn't open, visit: ${LINK}\nPaste code here if prompted > `))
  }

  exit(code: number, stderr = ''): void {
    if (stderr) this.stderr.emit('data', Buffer.from(stderr))
    this.emit('exit', code)
  }
}

const SPACE = { id: 'main', mcpToken: 't', files: { mcpConfig: 'm', settings: 's', emlConfig: 'e' } } as SessionSpace

function setup(opts: { configDir?: string; urlTimeoutMs?: number } = {}) {
  const processes: FakeLogin[] = []
  const spawned: Array<{ args: string[]; env: Record<string, string> }> = []
  const signedIn = vi.fn()
  const signIn = new ClaudeSignIn({
    configDirFor: () => opts.configDir ?? '/config/shared',
    signedIn,
    urlTimeoutMs: opts.urlTimeoutMs,
    spawn: (_bin, args, env) => {
      const child = new FakeLogin()
      processes.push(child)
      spawned.push({ args, env })
      queueMicrotask(() => child.printLink())
      return child as unknown as LoginProcess
    },
  })
  return { signIn, processes, spawned, signedIn }
}

describe('ClaudeSignIn', () => {
  it('starts `claude auth login` in the space\'s config folder and hands back the link it prints', async () => {
    const { signIn, spawned } = setup({ configDir: '/agents/a/claude-config' })
    const attempt = await signIn.start(SPACE)
    expect(attempt).toMatchObject({ state: 'waiting', url: LINK, takesCode: true, userCode: null, error: null })
    expect(spawned[0].args).toEqual(['auth', 'login', '--claudeai'])
    expect(spawned[0].env.CLAUDE_CONFIG_DIR).toBe('/agents/a/claude-config')
    expect(spawned[0].env.DISABLE_AUTOUPDATER).toBe('1')
  })

  it('writes the pasted code to the CLI\'s stdin and reports success', async () => {
    const { signIn, processes, signedIn } = setup()
    const { id } = await signIn.start(SPACE)
    const answer = signIn.submitCode(id, '  fake-code-123#fake-state  ')
    await Promise.resolve()
    expect(processes[0].written).toBe('fake-code-123#fake-state\n')
    expect(signIn.read(id)?.state).toBe('checking')
    processes[0].exit(0)
    expect(await answer).toMatchObject({ state: 'done', error: null })
    expect(signedIn).toHaveBeenCalledWith('/config/shared')
  })

  it('reports the CLI\'s refusal without the code in it', async () => {
    const { signIn, processes, signedIn } = setup()
    const { id } = await signIn.start(SPACE)
    const answer = signIn.submitCode(id, 'fake-code-456')
    processes[0].exit(1, "Couldn't log in: That code wasn't accepted (fake-code-456).\n")
    const result = await answer
    expect(result.state).toBe('failed')
    expect(result.error).toBe("That code wasn't accepted (…).")
    expect(JSON.stringify(result)).not.toContain('fake-code-456')
    expect(signedIn).not.toHaveBeenCalled()
  })

  it('refuses a code that is not one line of visible characters, and leaves the attempt open', async () => {
    const { signIn, processes } = setup()
    const { id } = await signIn.start(SPACE)
    await expect(signIn.submitCode(id, 'two words')).rejects.toThrow(/one line/)
    await expect(signIn.submitCode(id, '')).rejects.toThrow(/one line/)
    expect(processes[0].written).toBe('')
    expect(signIn.read(id)?.state).toBe('waiting')
  })

  it('is done without a code when the CLI finishes on its own (the browser on this computer)', async () => {
    const { signIn, processes, signedIn } = setup()
    const { id } = await signIn.start(SPACE)
    processes[0].exit(0)
    await Promise.resolve()
    expect(signIn.read(id)?.state).toBe('done')
    expect(signedIn).toHaveBeenCalledTimes(1)
  })

  it('cancel ends the process; a new start ends the open one', async () => {
    const { signIn, processes } = setup()
    const first = await signIn.start(SPACE)
    const second = await signIn.start(SPACE)
    expect(processes[0].killed).toBe(true)
    expect(signIn.read(first.id)).toBeNull()
    expect((await signIn.cancel(second.id))?.state).toBe('cancelled')
    expect(processes[1].killed).toBe(true)
    await expect(signIn.submitCode(second.id, 'fake-code')).resolves.toMatchObject({ state: 'cancelled' })
    expect(processes[1].written).toBe('')
  })

  it('rejects when the CLI shows no link', async () => {
    const processes: FakeLogin[] = []
    const signIn = new ClaudeSignIn({
      configDirFor: () => '/config/shared',
      signedIn: () => {},
      urlTimeoutMs: 20,
      spawn: () => { const child = new FakeLogin(); processes.push(child); return child as unknown as LoginProcess },
    })
    await expect(signIn.start(SPACE)).rejects.toThrow(/did not show a sign-in link/)
    expect(processes[0].killed).toBe(true)
  })

  it('rejects when the space has no folder for it, before starting anything', async () => {
    const spawn = vi.fn()
    const signIn = new ClaudeSignIn({ configDirFor: () => { throw new Error('no folder') }, signedIn: () => {}, spawn })
    await expect(signIn.start(SPACE)).rejects.toThrow('no folder')
    expect(spawn).not.toHaveBeenCalled()
  })

  it('runs the CLI with an allowlisted environment, never the host\'s Claude variables', () => {
    const env = loginEnv('/config/x', { PATH: '/bin', HOME: '/home/u', CLAUDE_CODE_OAUTH_TOKEN: 'fake-token', ANTHROPIC_API_KEY: 'fake-key', HTTPS_PROXY: 'http://proxy' })
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/u', HTTPS_PROXY: 'http://proxy', CLAUDE_CONFIG_DIR: '/config/x' })
    expect(env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN')
    expect(env).not.toHaveProperty('ANTHROPIC_API_KEY')
  })
})
