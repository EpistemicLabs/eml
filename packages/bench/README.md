# @engramprotocol/bench

Measures a build of EML against a fixed fixture brain, so a release can be compared with the one
before it — not only "do the tests pass", but "does the agent find and use the right knowledge".

## What it measures

The system under test is an EML checkout with built packages (`pnpm install && pnpm build`). The
bench talks to it only through the interfaces an agent uses: its REST server, its Claude Code hooks
and its MCP server. That is why the same bench can measure the current branch, a release worktree or
an older version.

1. **Fixture brain** — `fixture/brain.json`: a fictional solo maker with four projects, written
   with the hard cases on purpose (superseded decisions, an old and a new status per scope, the same
   words in different projects, rules with and without a trigger). It is written through the REST
   API of a *base* version (default: the version under test) and aged, so recency ranks as in a real
   brain. A base older than the version under test measures the brain as a user has it after the
   update: the server migrates it at startup.
2. **Questions** — `fixture/questions.json`: each question has a retrieval probe (stage 1) and a
   question in the user's words with a reference answer (stage 2).
3. **Stage 1: retrieval** (deterministic, no model). Each probe goes to the route the matching MCP
   tool calls (`eml_recall`, `eml_show`, the boot), and the markdown the agent would read is scored:
   - recall@5 / MRR — is the expected engram there, and how far up
   - coverage — share of all expected engrams that surfaced
   - stale rate — an outdated engram ranks above the current one
   - absent rate — an engram shows that must not (e.g. a superseded decision on a dashboard)
4. **Agent surface** (no model): what an agent reads before it acts — the session-start hook output,
   the prompt reminder and the tool list, in characters.
5. **Stage 2: agent** (`--agent`). A Claude model answers each question with the version's hooks as
   context and its MCP server as tools, on its own copy of the brain. Graded deterministically (did
   the tool output contain the expected engrams?) and by a judge model against the reference answer
   and the outdated claims listed for the question: accuracy, stale rate, evidence rate, tool calls,
   tokens. Two runners:
   - `claude-code` (default): headless Claude Code (`claude -p`) per question, isolated from the
     machine (own HOME and config dir, no built-in tools, only the `eml_brain` tools), with the
     version's MCP server and hooks configured as the cockpit does. Signs in with a Claude Code token
     (`CLAUDE_CODE_OAUTH_TOKEN`, or `--claude-token-file`). The Claude Code version goes into the
     result; compare two EML versions only on the same one.
   - `api`: a plain tool loop over the Anthropic Messages API (`ANTHROPIC_API_KEY`), no harness
     around the model — for comparing models.

Stage 1 under stage 2 separates the two kinds of failure: the brain did not surface the knowledge,
or the model did not use it.

## Run

```bash
pnpm -F @engramprotocol/bench build

# stage 1 + surface, the version in this checkout
node packages/bench/dist/cli.js run --eml .

# another build, on a brain written by this one (the update path)
node packages/bench/dist/cli.js run --eml ../eml-v0.19.0 --base .

# with stage 2 in Claude Code (token from `claude setup-token`)
node packages/bench/dist/cli.js run --eml . --agent --claude-token-file <file> [--model claude-opus-5-5] [--effort medium]

# stage 2 over the API instead (ANTHROPIC_API_KEY, costs API credit)
node packages/bench/dist/cli.js run --eml . --agent --runner api

# what changed between two results
node packages/bench/dist/cli.js compare packages/bench/results/0.18.2.json packages/bench/results/0.19.0.json
```

Results land in `results/<version>[-from-<base>].json` (checked in, one per release). Each run keeps
its data dir, server logs, the markdown of every probe, the surface texts and the stage-2 transcripts
in `work/` (ignored), for reading why a number moved.

## Limits

- The fixture and the questions are written by the people who build EML; they favour what EML was
  built to do. Questions from real sessions (against a private copy of a real brain, never checked in)
  are the counterweight.
- The fixture is small and its questions are direct: v0.18.2 with Opus 5.5 answers all of them
  (stage 2 accuracy 1.0), so stage 2 does not yet separate versions on correctness — only on effort
  (tool calls, tokens). Volume, contradictions without a supersede, multi-step and unanswerable
  questions come next.
- The fixture is written with the base version's write API, so a base must accept its format.
