---
name: brain-hygiene
description: Bring the brain in line with what the current schema expects and re-check what is due for review. Works through the findings of the brain's hygiene check, which the EML cockpit writes to findings.json in the space's "Brain hygiene" folder when it opens the session from its banner. Decides the clear cases itself, asks the user only where it is unsure or where their word is needed, and reports what it wrote. Invoke on "brain hygiene", "clean up the brain", "Brain aufräumen".
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

1. **Orient.** Read `findings.json`. Show per check one line: what it
   requires, how many entries, and who decides (`decides`: you / the user).
   Order: migration checks first, then reviews. Wait for the user to start.

2. **Agent checks** (`decides: agent`). `eml_get` each entry and follow the
   check's **how**. Clear → write it: one call per entry — an `eml_update` with
   content and the fields together, or for a refile the new engram of its type
   with `supersedes=[<old id>]` (a type never changes in place). Unsure → don't
   write; it goes on the open list. Unsure means you would have to guess a
   fact, content would be lost, or the how says to ask. If the server rejects
   a write, put the entry on the open list; don't write another version.

3. **Open entries.** Per check, one block with only the open entries:

       ## <check id> — open (<n>)

       <#>. [type] scope / title  (id: <short>)
          now:      "<current content, shortened>"
          proposed: "<new content>"
                    why "…" · detail "…" · trigger "…"
          (a refile: → [new type] title, supersedes <short>)

       → ok (all) · ok <#,#> · change <#>: … · skip <#> · stop

   Write what was approved, exactly as approved.

4. **User checks** (`decides: user`). One compact list per check, answered
   once:

       ## <check id> — <n> entries
       <#>. [type] title — <one line>

       → all ok · all ok except <#,#>

   Write what the answer covers with their words; go through the exceptions
   one by one, as the check's how says.

5. **Report.** At the end:

       ## Brain hygiene — written (<n>)
       <#>. [type] title — <what changed>  (id: <short>)
       OPEN / SKIPPED (<n>)
       <#>. [type] title — <why>

       → undo <#> · change <#>

   undo: `eml_update` back to the old content and fields; a refile: invalidate
   the new engram, then reactivate the old one (`eml_update status=active`).
   Skipped entries stay as they are.

## Guardrails
- Write on your own only in agent checks, and only the clear cases. Anything
  that needs the user's word — `agreed`, a new rule — never.
- Move, never drop: new content, why and detail together keep everything the
  old text said, unless the user drops something. A refile carries everything
  over to the new engram.
- Write each entry at most once per session.
- Stay in the file. Other cleanup you notice → mention it at the end, don't do it.
- Chat follows the conversation language; engram content stays English.
