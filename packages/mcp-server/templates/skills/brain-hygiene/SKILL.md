---
name: brain-hygiene
description: Bring the brain in line with what the current version expects and re-check what is due for review. Works through the findings of the brain's hygiene check — engrams that no longer fit a requirement of the current version, and engrams due for review — proposes a concrete change per finding and writes only after the user approves each block. The EML cockpit opens a session with it — after an update, when reviews pile up, or from Settings › Brain › Run brain hygiene now — with the findings in its first message. Invoke on "brain hygiene", "clean up the brain", "review the brain", "Brain aufräumen", "Reviews durchgehen".
---
<!-- managed-by: engramprotocol-setup -->

# brain-hygiene

Keep the brain fit: engrams written before a requirement of the current version
are brought in line with it, and engrams due for review are re-checked so stale
knowledge does not stay in force. This works brain → brain; `consolidate` is
session → brain and stays separate.

The skill knows no check itself. Each check says **what** it requires and
**how** an engram is brought in line; follow that.

## Where the findings come from

The findings come only from the cockpit. It runs the brain's hygiene check and
opens the session with the checks that have findings in its first message: each
with its kind (migration or review), what, how, and the engrams found (id, type,
scope, title, reason). Work from that list.

Invoked without that list (the user asked in a running session): say that the
full check runs from Settings › Brain › Run brain hygiene now. If the user wants
to go on here anyway, work only the review queue, one block per page:
`eml_list label=review limit=10`, then `offset=10`, `offset=20`, … for the next
blocks (decisions, rules and profiles past their review date, open tasks without
movement). Never fetch the whole queue at once — entries come with their full
content.

## Steps

1. **Orient.** Show the user what was found, per check: what it requires (one
   line), how many engrams, and — for a migration check — that it comes from an
   update. Order: migration checks first, then reviews. Give the counts as the
   check reports them; don't forecast how many findings a block will clear — the
   next hygiene run shows what is left.

2. **Propose per block.** Take one check at a time, in blocks of up to ~10
   engrams. For each engram `eml_get` it and propose a concrete change following
   the check's **how** — the exact new content and properties, not a summary.
   For a review: what still holds, what changed, and the verdict
   (confirm / update / supersede / invalidate / resolve). Show the block:

       ## <check id> — block <n> of <m>

       [type] scope / title  (id: <short>)
         now:      "<current content, shortened>"
         proposed: "<new content>"
                   properties: why "…" · detail "…" · trigger "…"
         reason:   <the finding's reason>

       → approve block · edit <#> · skip <#> · stop

   Stop and wait for the user.

3. **Write the approved block**, one `eml_update` per engram (content and
   properties in one patch). A review that still holds unchanged:
   `eml_update` with `properties.review_note` — why it still holds. Any change
   restarts the review by itself. Supersede and invalidate as the check's how
   says. A write the server rejects (format, validation) → fix the proposal and
   show it again; never force it through.

4. **Next block** until the checks are done or the user stops. Then a short
   report: written, skipped, left open. Left-open findings come back in the next
   hygiene run — nothing else needs to be recorded.

## Guardrails
- Write nothing without the user's approval of the block. No auto mode.
- Move, never drop: shortening content moves the rest into properties (why,
  detail), it does not delete it. When a meaning is unclear, ask.
- Don't confirm a review you cannot judge — ask the user what holds.
- Stay in the findings. Other cleanup you notice → mention it at the end, don't
  do it.
- Chat follows the conversation language; engram content stays English.
