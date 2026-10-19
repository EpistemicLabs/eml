# Proposal: the cockpit on native Windows

Status: in progress. Step 1 (an informative Windows CI job) ships with this proposal.

## Why

A first user wants to run the cockpit on Windows. Nobody on the team works on Windows, so the plan
has to work without a Windows machine at hand: GitHub's `windows-latest` runners (free for a public
repository) are the test machine, and every step is checked there before a person tries it.

Native Windows, not WSL. WSL2 is a stopgap for an experienced user: the agent runtimes already
support Linux, but the installer (`scripts/install.sh`) is macOS-only, so it means the Linux
quick-start from source. Nobody has run the cockpit in WSL2 yet.

## What already works

- Agent CLIs are spawned directly in the PTY: no login shell, no `zsh`, no `-l -c`.
- Most paths go through `path.join` and `os.homedir()`; the mcp-server config falls back to
  `USERPROFILE`.
- node-pty (ConPTY) and the SQLite binding ship Windows prebuilds. better-sqlite3 13 bundles them
  in the package (`prebuilds/win32-x64.node`); pnpm must not rebuild it from source, which needs
  Visual Studio (found by the first Windows CI run, fixed with this proposal). npm, which installs
  the released cockpit, skips the build already (`gypfile: false`).
- No Keychain or other macOS credential store; config isolation via `CLAUDE_CONFIG_DIR` and
  `CODEX_HOME` is portable.
- Pid lock files (`process.kill(pid, 0)`) and port allocation (`listen(0)`) are portable.

## What breaks

In the order a Windows user would hit it. B = blocker, D = degraded.

### Agent runtime (B, nothing starts without it)

- `managed-runtime.ts` `platformKey()` knows only `darwin` and `linux`, so the Claude Code download
  at host start throws `unsupported platform`.
- Binary names lack `.exe` (`claude/runtime.ts`, `codex/runtime.ts`); Codex is unpacked with
  `/usr/bin/tar`.
- `switchCurrent` and the runtime's `bin/` entry are symlinks. `fs.symlinkSync` needs admin rights
  or Developer Mode on Windows.
- The `--version` self-test runs with `PATH=/usr/bin:/bin` and `HOME` only; Windows binaries need
  `SystemRoot`, `USERPROFILE`, `TEMP`.

### Session environment (B)

- `pty-bridge.ts` `AGENT_ENV_ALLOWLIST` is POSIX-only: no `SystemRoot`, `windir`, `ComSpec`,
  `PATHEXT`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`. Without `SystemRoot`, Node and Rust
  binaries fail at crypto and DNS. Claude Code on Windows also needs Git Bash
  (`CLAUDE_CODE_GIT_BASH_PATH`).
- `PATH` is joined with `:` (`claude/index.ts`, `codex/index.ts`, `app-update.ts`) instead of
  `path.delimiter`.

### Hook commands (B)

The commands written into the Claude and Codex settings are POSIX shell: single quotes
(`shared.ts` `quote()`), `curl … "$COCKPIT_SESSION_ID" … >/dev/null 2>&1 || true` for turn state,
`'<home>/bin/node' … --config "$EML_HOOK_CONFIG"` for the EML hooks, and a symlinked hook node.
On Windows the CLIs run hooks through cmd or PowerShell, so turn state and the EML hooks are lost.

### Process management (B for the service, D otherwise)

- Autostart is launchd only (`service.ts`); the updater restarts only under launchd, looks for
  `npm` (Windows: `npm.cmd`, which `execFile` can't run without a shell) and switches versions by
  symlink (`app-update.ts`).
- `SIGTERM` is a hard kill on Windows: the brain server's graceful shutdown (pool drain, WAL
  checkpoint) never runs.

### Install (B)

`install.sh` refuses anything but macOS and uses `launchctl`, `shasum`, `ln -sfn`, `open`;
`install-app.sh` is bash; the host's `dev` script uses POSIX inline env.

### Smaller (D)

- Folder paths: `spawn-api.ts` treats only `/…` and `~` as paths; the project wizard's folder
  browser is POSIX-only (no `C:\`, no drive switch); `~\` is not expanded.
- Browser launch (`index.ts`) and "Reveal brain file" (`brain-info.ts`) use `open`/`xdg-open`.
- Shortcuts: Chrome and Edge keep Ctrl+1–9 for their own tabs, so the desk shortcuts never
  arrive; the terminal's kill-line is bound to Cmd+Backspace only.
- CI runs on Linux only.

## The plan

Small PRs on `main`, each one working on its own and invisible on macOS. Nobody has to stop
committing.

| Step | What | Done when |
| :- | :- | :- |
| 1 | **Windows CI job**, informative (`continue-on-error`, not a required check): build, all tests, both bundles. | The job runs on every PR and shows what breaks. |
| 2 | **Smoke test** on all three OSes: install the packed release, start the host, check health, open a PTY session with a stub agent, fire the hooks and see the turn state arrive, download and self-test the real agent binary. | The test runs in CI; red on Windows. |
| 3 | **Cross-platform hooks and plumbing**: one node-only hook (`"<node>" "<cli>" hook <name>`) that reads its config from env or file and posts with `fetch`, so no curl and no shell syntax; `path.delimiter`; shutdown over IPC instead of signals. | Same behaviour on macOS and Linux; hooks pass the smoke test on Windows. |
| 4 | **Native runtime**: `win32-x64`/`win32-arm64` in `platformKey`, `.exe`, junctions instead of symlinks (or the real exe path), a Windows env allowlist, Windows `tar`. | Windows CI and smoke test green → the job becomes required. |
| 5 | **Click test** in a Windows VM (cloud VM by the hour, or Windows 11 ARM in UTM/Parallels), then the first user as beta tester, reporting with `/report-issue`. | A real session works end to end in the browser. |
| 6 | **Install and run**: `install.ps1` with the same version layout, autostart via Task Scheduler, updater (`npm.cmd`, junction switch, restart), folder browser, shortcuts. | A user installs and updates without a terminal. |

Until step 6 a Windows user starts the cockpit by hand.

## Architecture

The host already has a port for the agent CLIs (`domain/agent-provider.ts`, adapters under
`infrastructure/providers/`). Platform differences get the same shape, instead of `process.platform`
checks spread over the code:

- **A platform port** (`domain/platform.ts`) with one adapter per OS under
  `infrastructure/platform/`. It holds only what really differs: activating a version (symlink or
  junction), executable names, the session env allowlist, opening a URL and revealing a file,
  autostart, restart after an update, stopping a process, and file modes. The adapter is picked once
  at startup; everything else takes the port.
- **Hooks as data.** A provider declares its hooks (event, node entry, arguments); one renderer turns
  them into the command for the OS. No shell strings built in three places, and the rendering is
  testable on its own.
- **A guard rail**: a lint rule allows `process.platform` only in `infrastructure/platform/`.
- **Tests against a fake platform**, so the Windows cases (paths in the Codex config, `.exe`, env)
  also run on macOS, and no test needs a skip-on-Windows switch.

No big-bang move of the flat top-level modules: what the Windows work touches moves to its layer,
the rest stays where it is.

## Open questions

- Windows on ARM: support `win32-arm64` from the start, or x64 only? Depends on which builds the agent CLIs publish (to check).
- Git Bash is a prerequisite of Claude Code on Windows: check for it in the installer, or leave it
  to Claude Code's own error?
- Codex's sandbox on Windows is its own and experimental: keep `--sandbox workspace-write` there or
  start without?
