# Proposal: consolidate before the context is compacted

Status: built as proposed, in `packages/mcp-server/src/hooks/compaction.ts` and the `consolidate`
skill. Not yet observed in a real session: whether an agent acts on the two hints.

## The problem

A long session ends up compacted: the agent CLI replaces the conversation with a summary. The
summary is written to keep the current task going. It is not written to keep what belongs in the
brain, so decisions, status changes and loose ends from the compacted part can be lost before
anyone ran `consolidate`.

The `consolidate` skill already names this moment ("Before context gets compacted, if the session
did real work"), but nothing prompts the agent or the user when it arrives.

## What Claude Code allows

Checked against the Claude Code hooks reference:

| Hook | What it can do | What it cannot do |
| :- | :- | :- |
| `PreCompact` | Run a command; block the compaction (exit 2 or `decision: "block"`). | Add instructions to the summary or put text into the context. Its stdout goes to the debug log. |
| `PostCompact` | Run a command; it receives the finished summary (`compact_summary`). | Change the result or put text into the context. |
| `SessionStart` with `source: "compact"` | Put text into the context right after a compaction. | Run before the compaction. |
| `UserPromptSubmit` | Put text into the context with each prompt. | See the context usage: no hook input carries it. |

Two consequences:

- **No hook can run a skill or give the agent a turn.** `consolidate` needs one: it recalls against
  the brain and judges what is worth keeping. A hook can only ask the agent, in the context, to run
  it.
- **The compaction itself cannot be made to consolidate.** It writes one summary text and has no
  tools.

Every hook input carries `transcript_path`. The transcript records the token usage of each
response, so a hook can read how large the context is.

Compaction has no fixed trigger point. One long cockpit session was compacted automatically twice,
at about 307k and about 595k tokens. A rule like "warn at 75 % of the window" would miss cases like
the first one, and the hook does not know the window size either.

## Proposal

Two small additions to the EML hooks in `packages/mcp-server`, and a second mode for the skill.
Both only add text to the context;
the agent then runs `consolidate` in its auto mode, which part 3 adds to the skill.

### 1. A nudge while the session grows (`UserPromptSubmit`)

The reminder hook reads the context size from the end of the transcript. Each time the context has
grown by a fixed step since the session start, the last nudge or the last compaction, it adds one
hint:

```
[EML] This session has grown by about <N>k tokens since its last save point and may be compacted
soon. If real work happened since then: answer this prompt first, then run the consolidate skill
in auto mode.
```

- **Step, not percentage:** a step works without knowing the window size and also covers an early
  compaction. Proposed step: 150k tokens.
- **State:** one small file per session next to the turn counter (`<config dir>/state`). A session
  the hook sees for the first time starts counting there, so an old session is not nudged at once.
  A context that shrank was compacted and starts a new count.
- **Cost:** the hook reads only the last megabyte of the transcript file.
- **Failure:** silent, like every EML hook. The transcript format is Claude Code's own and not a
  documented contract; if it changes, the nudge stops and nothing else breaks.

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

This is the safety net for compactions the nudge did not announce. It works with less detail than a
consolidation before the compaction, which is why part 1 comes first.

### 3. An auto mode for `consolidate`

`/consolidate` stays as it is when the user invokes it: it shows a diff and writes only after
approval. The hints of parts 1 and 2 ask for "consolidate in auto mode" instead, because a hint
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

Both parts live in `packages/mcp-server/src/hooks`, so a standalone EML client gets them too. The
cockpit needs no new hook entry: it already registers `session-start` and `user-prompt-submit` for
each space. Both texts are agent-facing product surface and are part of this review.

## Rejected

- **Steer the summary from `PreCompact`.** Not possible: the hook's output never reaches the
  summary.
- **Block the compaction until the session is consolidated.** A blocked compaction that was meant
  to recover from a context-limit error makes the request fail, and an idle session would stay
  blocked with nobody there to consolidate.
- **Write to the brain from a hook, without the agent.** It skips recall-before-write and the
  agent's judgment of what is worth keeping, the two things that keep duplicates and noise out of
  the brain.
- **A background session per compaction.** The host could start a session that reads the
  transcript and consolidates it. It is the most complete option, and it costs a second agent run per
  compaction, working without the user who could answer its questions. Worth revisiting only if parts
  1 and 2 still lose things.

## Open questions

1. **Step size.** Is 150k tokens right, and should the nudge repeat at every step or fire once?
2. **Knowing that a consolidation happened.** The proposal does not detect it; the agent sees its
   own consolidation in the context and ignores the nudge. Should the hook reset its counter when
   the session wrote its log engram?
3. **Codex.** The cockpit registers `SessionStart` and `UserPromptSubmit` for Codex too. Whether
   Codex reports a compaction, and how its session files record usage, is not checked. Proposed:
   Claude Code first, Codex as a follow-up.
4. **Wording.** Both hook texts above are drafts.
5. **What auto may write.** Is "additions yes, closing and replacing no" the right line? A new
   status supersedes the prior one and is allowed; rules written in auto mode change how the agent
   works in later sessions and are allowed too.

## What was checked

- The hook behaviour above was read in the Claude Code hooks reference.
- The usage fields and the two compaction points were read in the transcript of a real session.
- Unit tests cover the size reading, the step logic, the reset after a compaction and the hint
  after a compaction. The built hook was run against the transcript of a real session.
- Not checked: an agent acting on either hint, the auto mode of the skill run by an agent, and
  Codex.
