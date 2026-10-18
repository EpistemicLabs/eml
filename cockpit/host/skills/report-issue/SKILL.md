---
name: report-issue
description: Report a bug or a feature request for EML / the EML cockpit as an issue in the public GitHub repo EpistemicLabs/eml. Gathers what happened from the session and the user, adds the environment, checks for an existing issue, shows the full draft and creates the issue only after the user approved it. Invoke when the user says "report an issue", "report a bug", "file an issue", "feature request for the cockpit", "Bug melden", "Issue aufmachen", "Feedback an EML".
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
- **Environment** (bugs) — collect, don't ask:
  - cockpit version: `node -p "require(require('path').join(require('path').dirname(process.env.COCKPIT_SPAWN_JS), '..', 'package.json')).version"`
    (if `COCKPIT_SPAWN_JS` is unset, the session is not in the cockpit: leave the version out or ask);
  - OS: `uname -sr` (macOS: `sw_vers -productVersion`);
  - agent CLI: `claude --version` or `codex --version`, whichever this session runs;
  - browser and version, when the bug is in the cockpit UI — ask.

## 2. Keep it clean

Before drafting, strip anything private. The issue must not contain:

- names of people, customers or companies, e-mail addresses, brain content
  (engram text, project names, task titles), conversation content;
- home or project paths — replace with `~/…` or `<project>`;
- secrets of any kind — tokens, keys, `.env` values, URLs with credentials.

Shorten logs to the lines that show the error. When in doubt, leave it out and
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
## Environment              <!-- bugs only: cockpit, OS, agent CLI, browser -->
## Notes                    <!-- logs, screenshots described, workarounds -->
```

Leave out sections that would stay empty. Show the user the complete title,
label and body and ask for an explicit go. Never create the issue without it —
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

Encode with `python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.stdin.read()))'`.
Browsers cut very long URLs: if the encoded body is over ~6000 characters,
shorten the logs, or give the user the body to paste.
