# @engramprotocol/bench

Measures a build of EML against a fixed fixture brain, so a release can be compared with the one
before it — not only "do the tests pass", but "does the agent find and use the right knowledge".

## What it measures

The system under test is an EML checkout with built packages (`pnpm install && pnpm build`). The
bench talks to it only through the interfaces an agent uses: its REST server, its Claude Code hooks
and its MCP server. That is why the same bench can measure the current branch, a release worktree or
an older version.

1. **Fixture brain** — `fixture/brain.json` (the engrams the questions are about) and
   `fixture/volume.json` (everything around them): a fictional solo maker with seven projects, about
   180 engrams, written with the hard cases on purpose — superseded decisions, an old and a new status
   per scope, newer notes that contradict older ones without superseding them, the same words in
   different projects, rules with and without a trigger, routine entries (weekly order numbers,
   closed tasks, posts, session logs). It is written through the REST
   API of a *base* version (default: the version under test) and aged, so recency ranks as in a real
   brain. A base older than the version under test measures the brain as a user has it after the
   update: the server migrates it at startup.
2. **Questions** — `fixture/questions.json`: each question has a retrieval probe (stage 1) and a
   question in the user's words with a reference answer (stage 2). Categories: direct, paraphrase,
   current over stale, silent contradiction, scope, dashboard, rule, implicit rule (a request a rule
   applies to without the question naming it), multi-step (the answer needs two engrams), unanswerable
   (the brain does not know — the agent must say so), history.
3. **Stage 1: retrieval** (deterministic, no model). Each probe goes to the route the matching MCP
   tool calls (`eml_recall`, `eml_show`, the boot), and the markdown the agent would read is scored:
   - recall@5 / MRR — is the expected engram there, and how far up
   - coverage — share of all expected engrams that surfaced
   - stale rate — an outdated engram ranks above the current one
   - absent rate — an engram shows that must not (e.g. a superseded decision on a dashboard)
4. **Agent surface** (no model): what an agent reads before it acts — the session-start hook output,
   the prompt reminder and the tool list, in characters.
5. **Stage 2: agent** (`--agent`). A Claude model answers each question in a fresh session, per arm
   and `--repeat` times, on its own copy of the memory. Arms (`--arms`):
   - `eml` — the brain, through the version's hooks and MCP server
   - `claude-md` — the same knowledge as a CLAUDE.md in the working directory (the free
     alternative). Built generously: every engram that is current in EML, by project, with its date;
     superseded entries left out as if kept tidy by hand; silent contradictions kept (EML does not
     know them either)
   - `none` — no memory (the floor)

   The answer is graded deterministically (eml arm: did the tool output contain the expected
   engrams?) and by a judge model against the reference answer and the outdated claims listed for the
   question: accuracy (overall and per run), stale rate, evidence rate, tool calls, tokens, and how
   many answers changed the memory on the way (writes). Two runners:
   - `claude-code` (default, all arms): headless Claude Code (`claude -p`) per session, isolated
     from the machine (own HOME and config dir, working directory outside any repository so no
     CLAUDE.md is read from a parent directory, auto-memory off except in the claude-md arm's
     scenarios); in the eml arm only the `eml_brain` tools, with the version's MCP server and hooks
     configured as the cockpit does. Signs in with a Claude Code token
     (`CLAUDE_CODE_OAUTH_TOKEN`, or `--claude-token-file`). The Claude Code version goes into the
     result; compare two EML versions only on the same one.
   - `api` (eml arm only): a plain tool loop over the Anthropic Messages API (`ANTHROPIC_API_KEY`),
     no harness around the model — for comparing models.

6. **Scenarios: work over time** (`--scenarios`, `fixture/scenarios.json`). One memory, several
   sessions, each a fresh agent. Earlier sessions bring new information in passing, next to the
   actual request (a price change, a new rule, a finished task, a new customer); a later session asks
   for it. A pass needs the agent to have written it down when it heard it and to find it again. The
   eml arm writes through its tools; the claude-md arm may edit the file and keeps Claude Code's own
   auto-memory (part of the free alternative); the none arm cannot carry anything over.

Stage 1 under stage 2 separates the two kinds of failure: the brain did not surface the knowledge,
or the model did not use it.

## Release benchmark (internal)

Does an update make things better or worse? Two commands, both on the version in a checkout:

- `eml-bench check --eml .` — **CI gate.** Stage 1 and the agent surface, no model. Compared with
  the newest checked-in result on the same fixture, up to this version; fails if any stage-1 number
  got worse. Stage 1 is deterministic (two runs give identical results), so a drop is a real change
  in what the agent reads, not noise.
- `eml-bench release --eml .` — **release step.** Stage 1, surface and the agent stage on the eml
  arm with three runs per question. Writes `results/<version>.json` (commit it with the release) and
  prints the change from the previous release for the release notes. Not a gate: the agent stage is
  sampled, so read the per-run spread before reading one question's change.

Each result carries a hash of the fixture; only results on the same fixture are compared, and
`check` fails when the checked-in results are all on another fixture — a fixture change without a
renewed baseline would otherwise switch the gate off unnoticed. After changing the fixture or the
questions, or after an intended stage-1 change, renew the baseline in the same change:
`eml-bench release --eml <checkout of the last release>` (`--no-agent` for stage 1 only) and commit
the result.

## Run

```bash
pnpm -F @engramprotocol/bench build

# release benchmark (see above)
node packages/bench/dist/cli.js check --eml .
node packages/bench/dist/cli.js release --eml . --claude-token-file <file>

# stage 1 + surface, the version in this checkout
node packages/bench/dist/cli.js run --eml .

# another build, on a brain written by this one (the update path)
node packages/bench/dist/cli.js run --eml ../eml-v0.19.0 --base .

# with stage 2 in Claude Code (token from `claude setup-token`)
node packages/bench/dist/cli.js run --eml . --agent --claude-token-file <file> [--model claude-opus-5-5] [--effort medium]

# EML against the free alternative and no memory, three runs each, plus the scenarios
node packages/bench/dist/cli.js run --eml . --agent --scenarios --arms eml,claude-md,none --repeat 3 --claude-token-file <file>

# stage 2 over the API instead (ANTHROPIC_API_KEY, costs API credit)
node packages/bench/dist/cli.js run --eml . --agent --runner api

# what changed between two results
node packages/bench/dist/cli.js compare packages/bench/results/0.18.3.json <work dir>/result.json
```

`release` writes `results/<version>.json` (checked in, one per release); `run` and `check` write
their result into the run's work dir (`--out` for another place). Each run keeps
its data dir, server logs, the markdown of every probe, the surface texts and the stage-2 transcripts
in a work dir (`<tmp>/eml-bench/`, or `--work-dir`; it must lie outside the repository), for reading
why a number moved.

## Limits

- The fixture and the questions are written by the people who build EML; they favour what EML was
  built to do. Questions from real sessions (against a private copy of a real brain, never checked in)
  are the counterweight.
- One run is one sample per question: a question can pass in one run and fail in the next. Compare
  versions with `--repeat` and read the per-run spread before reading a single question's change.
- The CLAUDE.md arm holds the whole fixture (~18k characters) in context. At this size a flat file is
  easy to read in full; a real brain is several times larger. The comparison says how EML does
  against the free alternative at fixture size, not at real size.
- With Opus 5.5 most questions pass; differences between versions show first in the silent
  contradictions, in effort (tool calls, tokens) and in writes.
- Dates in the fixture are relative to the run; a fixture text must not name an absolute date the
  agent could compare with today.
- The fixture is written with the base version's write API, so a base must accept its format.
