---
name: report-issue
description: Report a bug or a feature request for EML / the EML cockpit as an issue in the public GitHub repo EpistemicLabs/eml. Gathers what happened from the session and the user, adds the cockpit's redacted diagnostics (versions, runtimes, autostart, host log), checks for an existing issue, shows the full draft and creates the issue only after the user approved it. Invoke when the user says "report an issue", "report a bug", "file an issue", "feature request for the cockpit", "Bug melden", "Issue aufmachen", "Feedback an EML".
---
<!-- managed-by: engramprotocol-setup -->

# report-issue

Turns a problem with EML or the cockpit into a GitHub issue in
[EpistemicLabs/eml](https://github.com/EpistemicLabs/eml). The repo is
**public**: everything in the issue can be read by anyone, forever.

Only for EML itself: the cockpit, the brain, the MCP server, the shipped
skills and hooks. A bug in the user's own project is not an EML issue; say so.

## 1. Gather

From the session first, then ask the user only for what is missing:

- **Kind** — bug (label `bug`) or feature request (label `enhancement`).
- **Bug:** what the user did (steps), what they expected, what happened instead,
  how often (always, sometimes, once), error messages verbatim.
- **Feature:** the problem it solves, the behaviour wanted, alternatives tried.
- **Diagnostics** (bugs) — collect, don't ask. Inside the cockpit run its
  diagnostics command; it prints one Markdown block with the cockpit version and
  how it runs, OS and node, the autostart, the Claude Code and Codex runtimes
  with their last install or update result, the app updater, and the host log's
  errors and last lines — already redacted (project folders and names, user
  name, home paths, ids, tokens):
  - bash, zsh, Git Bash: `node "$COCKPIT_DIAGNOSE_JS"`
  - PowerShell: `node $env:COCKPIT_DIAGNOSE_JS`

  The block goes into the issue **as printed**, inside `<details>` at the end
  (step 4) — don't reword it, don't spread it over the other sections, don't
  drop its log parts: maintainers read it as a whole.

  If `COCKPIT_DIAGNOSE_JS` is unset (an older cockpit, or not a cockpit session),
  collect by hand instead: the cockpit version from Settings › About (ask), OS
  (`uname -sr`; macOS `sw_vers -productVersion`; Windows `[Environment]::OSVersion`),
  and `claude --version` or `codex --version`, whichever this session runs.
- **Browser** and version, when the bug is in the cockpit UI — ask.

## 2. Keep it clean

Before drafting, strip anything private. The issue must not contain:

- names of people, customers or companies, e-mail addresses, brain content
  (engram text, project names, task titles), conversation content;
- home or project paths — replace with `~/…` or `<project>`;
- secrets of any kind — tokens, keys, `.env` values, URLs with credentials.

The diagnostics block is redacted by the cockpit, but read it once before it
goes into the draft: a name it does not know (a customer named in a log line,
say) can still be there — replace it like the rest. Logs you add yourself:
shorten them to the lines that show the error. When in doubt, leave it out and
mention it in the summary to the user.

## 3. Check for an existing issue

```bash
gh issue list --repo EpistemicLabs/eml --state all --search "<2–4 keywords>" --limit 10
```

If one matches, show it and offer to add a comment there instead
(`gh issue comment <number> --repo EpistemicLabs/eml --body-file <file>`).

## 4. Draft and approve

Title: short and specific, no prefix ("Terminal pane loses focus after desk
switch", not "Bug: problem"). Body:

```markdown
## What happened            <!-- feature: ## Problem -->
## Steps to reproduce       <!-- feature: ## Proposal -->
## Expected
## Environment              <!-- bugs only: browser, anything the diagnostics lack -->
## Notes                    <!-- screenshots described, workarounds -->

<details><summary>Diagnostics</summary>

<!-- the diagnostics block, unchanged except for what step 2 removed -->

</details>
```

Leave out sections that would stay empty. Show the user the complete title,
label and body — the diagnostics too, in full — and ask for an explicit go. Never create the issue without it —
it is published the moment it is created.

## 5. Create

Write the body to a temporary file, then:

```bash
gh issue create --repo EpistemicLabs/eml --title "<title>" --label <bug|enhancement> --body-file <file>
```

Give the user the issue link.

**Without `gh`** (not installed, or `gh auth status` fails): don't install or
log in on the user's behalf. Build a prefilled link instead and give it to the
user to open and submit themselves:

```
https://github.com/EpistemicLabs/eml/issues/new?title=<url-encoded>&labels=<label>&body=<url-encoded>
```

Encode with `node -e "process.stdout.write(encodeURIComponent(require('fs').readFileSync(0, 'utf8')))" < <file>`.
Browsers cut very long URLs: if the encoded body is over ~6000 characters
(diagnostics usually are), put the body without the diagnostics in the link and
give the user the diagnostics block to paste as the first comment.
