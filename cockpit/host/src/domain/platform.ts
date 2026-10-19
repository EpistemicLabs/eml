/**
 * What differs between the operating systems the host runs on, behind one port
 * (docs/proposals/windows-support.md, "Architecture"). Code outside the
 * adapters asks the platform and never checks `process.platform` itself — a
 * test keeps it that way (tests/platform.test.ts).
 *
 * Domain layer: the interface only. Adapters live in infrastructure/platform/;
 * a method joins it when some code needs that difference, not before.
 */

export type PlatformOs = 'darwin' | 'linux' | 'win32'

export interface Platform {
  readonly os: PlatformOs

  /** An executable's file name: `codex` → `codex.exe` on Windows. */
  exe(name: string): string

  /**
   * The platform part of an agent CLI's release name: `darwin-arm64`,
   * `linux-x64`, `win32-x64`. `musl`: say `linux-x64-musl` on a musl Linux.
   */
  runtimeKey(opts?: { musl?: boolean }): string

  /** Variables a session inherits from the host on top of the common ones (pty-bridge.ts). */
  readonly sessionEnvKeys: readonly string[]
  /** The LANG a session gets when the host has no locale at all; null: none needed. */
  readonly fallbackLang: string | null

  /** Open a URL in the user's browser, best-effort (no browser: nothing happens). */
  openUrl(url: string): void
  /** Show a file in the OS file manager (selected where the OS can). */
  revealFile(file: string): Promise<void>

  /**
   * Point the directory link `link` at the directory `target`, replacing what
   * is there: macOS, Linux a relative symlink swapped in by one atomic rename;
   * Windows a junction (no admin rights needed), removed and created anew.
   */
  switchDirLink(target: string, link: string): void
  /** Whether a file can be linked without admin rights (Windows: no — see ManagedRuntime.bin). */
  readonly linksFiles: boolean

  /** The least environment a downloaded binary needs to start: system paths, the user's home, temp. */
  minimalEnv(): Record<string, string>
  /** The system's tar (macOS, Linux, Windows 10 and later ship one). */
  tarBin(): string

  /** How to run npm: the program and the arguments before npm's own. */
  npm(): { program: string; args: string[] }
  /** Folders a host started by a service (minimal PATH) still searches for tools such as gh. */
  readonly toolDirs: readonly string[]

  /** Check a downloaded binary's code signature, where the OS has one; elsewhere the checksum is the check. */
  verifyCodeSignature(bin: string, teamId: string, publisher: string): Promise<void>
}
