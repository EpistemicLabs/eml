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

  /** Check a downloaded binary's code signature, where the OS has one; elsewhere the checksum is the check. */
  verifyCodeSignature(bin: string, teamId: string, publisher: string): Promise<void>
}
