---
name: brain-hygiene
description: Bring the brain in line with what the current schema expects and re-check what is due for review. Works through the findings of the brain's hygiene check, which the EML cockpit writes to findings.json in the space's "Brain hygiene" folder when it opens the session from its banner. Proposes a concrete change per finding and writes only after the user approves each block. Invoke on "brain hygiene", "clean up the brain", "Brain aufräumen".
---
<!-- managed-by: engramprotocol-setup -->

# brain-hygiene

Keep the brain fit: engrams written before a requirement of the current schema
are brought in line with it, and engrams due for review are re-checked so stale
knowledge does not stay in force. This works brain → brain; `consolidate` is
session → brain and stays separate.

The skill knows no check itself. Each check in the file says **what** it
requires and **how** an engram is brought in line; follow that.

## Where the findings come from

Only from `findings.json` in the current folder, written by the cockpit when
the session starts. No file → say that brain hygiene starts from the cockpit's
banner, and stop. Do not look for findings yourself.

## Steps

1. **Orient.** Read `findings.json`. Show per check: what it requires (one
   line) and how many entries. Order: migration checks first, then reviews.
   Wait for the user to start.

2. **Propose per block.** One check at a time; blocks of 10 for a migration
   check, 20 for a review. `eml_get` each entry and propose the exact change
   following the check's **how** — the new content and fields, not a
   summary:

       ## <check id> — block <n> of <m>

       <#>. [type] scope / title  (id: <short>)
          now:      "<current content, shortened>"
          proposed: "<new content>"
                    why "…" · detail "…" · trigger "…"
          (a refile: → [new type] title, supersedes <short>)

       → ok (all) · ok <#,#> · change <#>: … · skip <#> · stop

   A review that still holds fits one line: `<#>. [type] title — confirm: <why
   it still holds>`. Show the full text only to revise or withdraw. Then wait.

3. **Write what was approved**, exactly as approved: one call per entry — an
   `eml_update` with content and the fields together, or for a refile the new
   engram of its type with `supersedes=[<old id>]` (a type never changes in
   place). If the server rejects a write, do not write another version on your
   own — put a new proposal for that entry into the next block.

4. **Next block** until the file is done or the user stops. Then report:
   written, skipped, rejected. Nothing else is recorded; skipped entries stay
   as they are.

## Guardrails
- Write nothing without the user's approval. No auto mode.
- Move, never drop: new content, why and detail together keep everything the
  old text said, unless the user drops something. A refile carries everything
  over to the new engram.
- Write each entry at most once per session.
- Stay in the file. Other cleanup you notice → mention it at the end, don't do it.
- Chat follows the conversation language; engram content stays English.
