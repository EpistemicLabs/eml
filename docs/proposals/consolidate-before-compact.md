# Proposal: consolidate before the context is compacted

Status: built, in `packages/mcp-server/src/hooks/compaction.ts` and the `consolidate` skill. Since
v0.17.12 part 1 is a `Stop` hook; v0.17.9 shipped it as a hint with the next prompt (see "Part 1,
first version" below).

## The problem

A long session ends up compacted: the agent CLI replaces the conversation with a summary. The
summary is written to keep the current task going. It is not written to keep what belongs in the
brain, so decisions, status changes and loose ends from the compacted part can be lost before
anyone ran `consolidate`.

The `consolidate` skill already names this moment ("Before context gets compacted, if the session
did real work"), but nothing prompts the agent or the user when it arrives.

## What the agent CLIs allow

Checked against the Claude Code hooks reference:

| Hook | What it can do | What it cannot do |
| :- | :- | :- |
| `PreCompact` | Run a command; block the compaction (exit 2 or `decision: "block"`). | Add instructions to the summary or put text into the context. Its stdout goes to the debug log. |
| `PostCompact` | Run a command; it receives the finished summary (`compact_summary`). | Change the result or put text into the context. |
| `SessionStart` with `source: "compact"` | Put text into the context right after a compaction. | Run before the compaction. |
| `UserPromptSubmit` | Put text into the context with each prompt. | See the context usage: no hook input carries it. |
| `Stop` | Block the end of a turn once (`decision: "block"` with a `reason`); the agent continues with the reason in the same turn. A continued turn carries `stop_hook_active`. | Start a turn in an idle session. |

Codex's hooks reference documents the same for `Stop` (the reason becomes a continuation prompt,
`stop_hook_active` marks the continued turn), `SessionStart` with `source: "compact"`, and
`transcript_path` in every hook input. Its session files record a `token_count` event per response.

Two consequences:

- **No hook can run a skill.** `consolidate` needs the agent: it recalls against the brain and
  judges what is worth keeping. A hook can only ask the agent to run it — in the context, or, from
  `Stop`, as the reason to keep going.
- **The compaction itself cannot be made to consolidate.** It writes one summary text and has no
  tools.

Every hook input carries `transcript_path`. The transcript records the token usage of each
response, so a hook can read how large the context is.

Compaction has no fixed trigger point. One long cockpit session was compacted automatically twice,
at about 307k and about 595k tokens. A rule like "warn at 75 % of the window" would miss cases like
the first one, and the hook does not know the window size either.

## Proposal

Two additions to the EML hooks in `packages/mcp-server`, and a second mode for the skill. Both
hooks ask the agent to run `consolidate` in its auto mode, which part 3 adds to the skill.

### 1. Consolidate before the session goes idle (`Stop`)

When the agent ends a turn, the stop hook reads the context size from the end of the transcript.
Has the context grown by a fixed step since the session's last save point, it blocks the stop once:

```
{"decision":"block","reason":"[EML] This session has grown by about <N>k tokens since its last save
point and may be compacted soon. Before you stop, run the consolidate skill in auto mode and end
with its short report. If nothing store-worthy happened since the last save point, say so in one
line and stop."}
```

The agent consolidates in the same turn, after the user's request is done, with the full context
and a warm cache. The turn it continued carries `stop_hook_active`, and the hook lets that one end.

Why the end of a turn: a session is often compacted while it is idle, before the prompt cache
expires. A hint in the context waits there until the next prompt — the agent has no turn to act on
it. At the end of a turn the agent still has one.

- **Step, not percentage:** a step works without knowing the window size and also covers an early
  compaction. The step is 250k tokens (150k in the first version).
- **State:** one small file per session next to the turn counter (`<config dir>/state`). A session
  the hook sees for the first time starts counting there, so an old session is not stopped at once.
  A context that shrank was compacted and starts a new count.
- **Cost:** the hook reads only the last megabyte of the transcript file. For the user, a turn every
  250k tokens takes longer and ends with the consolidation report.
- **Both CLIs:** the hook reads Claude Code's transcript (usage of the last main-conversation
  response) and Codex's session file (the last `token_count` event).
- **Failure:** silent, like every EML hook. Neither CLI documents its transcript format as a
  contract; if it changes, the hook stops blocking and nothing else breaks.
- **Turn state in the cockpit:** Claude Code reports the first stop to the host, so a pane shows
  "done" while the agent consolidates. Codex reports tool use, so its pane shows "working" again.

#### Part 1, first version

v0.17.9 shipped part 1 as a hint the `UserPromptSubmit` hook added to the next prompt. In real use
both compactions after the release happened while the session was idle: the hint could not have
come in time, and the post-compaction note waited for the next prompt too. The `Stop` hook replaces
it.

### 2. A pointer after a compaction (`SessionStart`, `source: "compact"`)

The boot hook already runs after a compaction and reloads the brain. When the source is `compact`,
it puts this before the boot:

```
## Context was compacted
The conversation before this point is a summary now. The full transcript is at <transcript_path>.
If the compacted part held real work that was not consolidated, run the consolidate skill in auto
mode at the next natural stop, not in the middle of a running task: work from the summary and read
the transcript where the summary is too thin.
```

Before, not after: a hook output above 10,000 characters is cut to a preview of its start, and the
boot is trimmed to exactly that budget. The hint's length is taken off the boot's budget.

The `consolidate` skill gets a short section "After a compaction" that says the same from its side:
candidates come from the summary, details from the transcript.

This is the safety net for compactions part 1 did not prevent. It works with less detail than a
consolidation before the compaction, which is why part 1 comes first.

### 3. An auto mode for `consolidate`

`/consolidate` stays as it is when the user invokes it: it shows a diff and writes only after
approval. Parts 1 and 2 ask for "consolidate in auto mode" instead, because a hint
that ends in a question is easy to leave unanswered, and then the compaction comes first.

One skill, two modes; the steps before the writing are the same.

| | Default (`/consolidate`) | Auto (asked for by a hint) |
| :- | :- | :- |
| New engrams, task entries, stage changes, started tasks | after approval | written directly |
| Closing, invalidating or superseding something that exists | after approval | not written, listed as `HELD BACK — needs you` |
| Candidates the session does not settle | part of the diff | not written, listed as `HELD BACK — needs you` |
| Report | diff before the writes | report after the writes, with ids and `approve <#>` / `edit <#>` / `undo <#>` |

- **Why auto only adds:** a run nobody watches can then at worst leave an engram too many, which
  the report names with its id. It cannot close a task that is still open or replace a decision.
- **Not enforced by code:** the agent tells the modes apart by the wording of the hint. It can get
  it wrong in a single case; the skill says that in doubt the default applies.

Two separate skills were the alternative. They would keep about 130 lines of the same text in two
places.

The change is in `packages/mcp-server/templates/skills/consolidate/SKILL.md`. The skill was not
run with the new text.

### Where it lives

Both hooks live in `packages/mcp-server/src/hooks` (`eml-mcp-server hook stop`, and the existing
`hook session-start`), so a standalone EML client can use them too. The cockpit registers the stop
hook for Claude Code (each space's settings.json) and Codex (hooks.json, after its turn-state hook;
Codex asks once to trust the new hook). The texts are agent-facing product surface.

## Rejected

- **Steer the summary from `PreCompact`.** Not possible: the hook's output never reaches the
  summary.
- **Block the compaction until the session is consolidated.** A blocked compaction that was meant
  to recover from a context-limit error makes the request fail, and an idle session would stay
  blocked with nobody there to consolidate.
- **Write to the brain from a hook, without the agent.** It skips recall-before-write and the
  agent's judgment of what is worth keeping, the two things that keep duplicates and noise out of
  the brain.
- **The cockpit types `/consolidate` into an idle pane when `PreCompact` fires.** It would reach an
  idle session, but it races with the user typing in that pane and works only inside the cockpit.
  The `Stop` hook reaches the same moment from inside the agent CLI.
- **A background session per compaction.** The host could start a session that reads the
  transcript and consolidates it. It is the most complete option, and it costs a second agent run per
  compaction, working without the user who could answer its questions. Worth revisiting only if parts
  1 and 2 still lose things.

## Open questions

1. **Step size.** Is 250k tokens right, and should the hook block at every step or once per
   session?
2. **Knowing that a consolidation happened.** The proposal does not detect it; the agent sees its
   own consolidation in the context. Should a `/consolidate` the user ran move the save point?
3. **Codex.** Checked against its documentation and a real session file, not in a running Codex
   session.
4. **Wording.** Both hook texts above are drafts.
5. **What auto may write.** Is "additions yes, closing and replacing no" the right line? A new
   status supersedes the prior one and is allowed; rules written in auto mode change how the agent
   works in later sessions and are allowed too.

## What was checked

- The hook behaviour above was read in the Claude Code and Codex hooks references.
- The usage fields and the compaction points were read in the transcripts of real sessions.
- Unit tests cover the size reading for both CLIs, the step logic, the loop guard, the reset after
  a compaction and the note after a compaction.
- A real Claude Code turn with the stop hook (save point lowered) was blocked once, the agent
  continued, and the continued turn's stop was let through.
- The built hook read a real Codex session file and blocked.
- Not checked: a running Codex session with the hook (it needs the user to trust the hook), and
  the skill's auto mode run by an agent end to end.
