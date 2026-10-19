# Installing the EML Cockpit on a Mac

This guide is for you if you have never used GitHub or the Terminal. It takes about five minutes.
You don't need a GitHub account, and you don't need to download this repository.

**What you need**

- A Mac. On Windows, see [Installing on Windows (beta)](#installing-on-windows-beta) at the end.
- A Claude subscription. Your agent runs on it. You sign in on the first start.

## 1. Install Node.js

The cockpit runs on Node.js, a free runtime many apps use.

1. Open [nodejs.org](https://nodejs.org) and download the **LTS** version (the button that says "LTS").
2. Open the downloaded file and click through the installer.

Already have Node.js? The cockpit needs version 22 or newer. The installer in step 3 checks this
for you and tells you if yours is too old.

## 2. Open the Terminal

The Terminal is a Mac app where you type commands.

Press **Cmd + Space**, type **Terminal** and press **Enter**. A window with a text prompt opens.

## 3. Run the installer

Copy this line, paste it into the Terminal window (**Cmd + V**) and press **Enter**:

```bash
curl -fsSL https://github.com/EpistemicLabs/eml/releases/latest/download/install.sh | bash
```

It downloads the newest release, checks the cockpit's files against their published checksums, installs
them and starts the cockpit. When it says **Done**, your browser opens the cockpit at
[http://127.0.0.1:4317](http://127.0.0.1:4317). You can close the Terminal now.

> **Prefer to read a script before you run it?** Download it, look at it, then run it:
>
> ```bash
> curl -fsSLO https://github.com/EpistemicLabs/eml/releases/latest/download/install.sh
> open -e install.sh      # opens it in TextEdit
> bash install.sh
> ```

## 4. First start

The cockpit takes you through two short steps and asks you to **connect Claude**. This opens Claude's
own sign-in. After that, your agent starts and shows you around.

Everything stays on your computer. Your brain (what your agent learns) lives in the folder
`~/.eml-cockpit` in your home folder.

## Everyday use

- **Opening it:** the cockpit starts on its own every time you log in to your Mac. Open
  [http://127.0.0.1:4317](http://127.0.0.1:4317) in your browser. A bookmark helps.
- **Updates:** when a new version is out, the cockpit shows a banner. Click **Update** and it updates
  itself. You never need the Terminal for this.

## If something goes wrong

| What you see | What to do |
|---|---|
| `Node.js is not installed` | Do step 1, then open a **new** Terminal window and run step 3 again. |
| `Node.js … is too old` | Install the LTS version from [nodejs.org](https://nodejs.org) (step 1), then run step 3 again. |
| `download … failed` | Check your internet connection and run step 3 again. |
| `already installed` | Nothing to do. Open [http://127.0.0.1:4317](http://127.0.0.1:4317). |
| `port 4317 is already in use` | Another program uses the cockpit's address. If you started a cockpit some other way, stop it, then run step 3 again. |
| `run the command without sudo` | Paste the line from step 3 exactly as it is, without `sudo` in front. |
| `did not start within a minute` | Open an issue (below) and attach the file `host.log` from the `.eml-cockpit` folder in your home folder. |
| The browser says the page can't be reached | Wait a few seconds and reload. If it stays like that, log out of your Mac and back in. |

Still stuck? [Open an issue](https://github.com/EpistemicLabs/eml/issues) and paste what the Terminal
shows. Leave out anything personal.

## Uninstalling

Paste this into the Terminal to stop the cockpit and remove it from your login items:

```bash
node ~/.eml-cockpit/app/current/node_modules/eml-cockpit/dist/index.js service uninstall
```

Your brain stays in `~/.eml-cockpit`. Running the installer again later brings the cockpit back with it.

To remove the brain too, delete that folder. **This deletes everything your agent has learned and cannot
be undone.** If you might want it later, back it up first: Settings › Brain › **Back up now**, then copy
the backup out of `~/.eml-cockpit/backups` (for example into your Documents folder). The backups live
inside the folder you are about to delete.

## Installing on Windows (beta)

The cockpit runs on Windows 10 and 11 too. It is new there: it is tested automatically on every change,
but few people have used it yet. If something looks wrong, tell us: inside a session, type
`/report-issue`.

**What you need:** Node.js 22 or newer from [nodejs.org](https://nodejs.org) (the **LTS** installer), and
a Claude subscription. Recommended: [Git for Windows](https://git-scm.com/download/win) (default options) —
Claude Code runs its shell commands in Git Bash when it is there, else in PowerShell. No admin rights
needed.

1. Install Node.js (and Git for Windows) as above.
2. Open **PowerShell**: press the **Windows key**, type **PowerShell** and press **Enter**.
3. Paste this line (right-click pastes) and press **Enter**:

   ```powershell
   irm https://github.com/EpistemicLabs/eml/releases/latest/download/install.ps1 | iex
   ```

It checks the files against their published checksums, installs the cockpit into `.eml-cockpit` in your
user folder and opens it at [http://127.0.0.1:4317](http://127.0.0.1:4317). From then on it starts on its
own when you log in (a PowerShell window may flash up for a moment) and updates itself through the banner,
as on a Mac.

To uninstall, paste this into PowerShell. Your brain stays in `.eml-cockpit`, as on a Mac:

```powershell
node "$env:USERPROFILE\.eml-cockpit\app\current\node_modules\eml-cockpit\dist\index.js" service uninstall
```
