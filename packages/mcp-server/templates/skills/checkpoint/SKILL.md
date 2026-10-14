---
name: checkpoint
description: Mid-session orientation, pulled manually when the user feels drift or overload. Sorts the live session into decided / open / blocked / dropped, surfaces the threads still in the air, then proposes what would go to the brain and how to proceed — with options. Read-only and lightweight by design; the point is a low threshold to invoke. It sorts and proposes, it does not write — consolidate persists. Invoke on "checkpoint", "where are we", "let's sort this", "wo stehen wir", "kurz sortieren", "innehalten".
---
<!-- managed-by: engramprotocol-setup -->

# checkpoint

Pause mid-session and get the picture straight — before the context drifts far
enough that reconstructing it becomes archaeology. The deliverable is **clarity
now**, not persistence.

Stay cheap: read the session, sort it, propose. **No writes.** A low threshold to
invoke is the whole feature — if this ever feels like half a consolidate, it's
too heavy.

**Neighbours:** `consolidate` is the *save* half (end of session, writes the
brain). The `session-discipline` system rule is the *automatic* version of this
pause. This skill is the *manual* pull — sort the live state, hand the rest to
consolidate.

## Steps

1. **Sort the live session** into four buckets — decided ✅ / open 🔲 / blocked ⛔
   / dropped ❌ — and list the **threads still in the air** so the user sees if
   the session is spreading thin. Blocked means a task with blockers (its status
   stays planned), not a status of its own.

2. **Surface the picture** in chat and stop:

       ## Checkpoint — <date>

       THREADS IN THE AIR (n)
         • <thread> — <one line>

       ✅ decided (n)    <title> — <one line>
       🔲 open (n)       <title> — <one line>
       ⛔ blocked (n)    <title> — waiting on <what>
       ❌ dropped (n)    <title>

3. **Propose — don't write.** Two short proposals, both optional for the user:
   - *Brain candidates:* the facts that would actually be lost if compaction hit
     before consolidate (decision made / status changed / newly blocked /
     progress worth an entry on task X). As many
     as there genuinely are — no cap, but don't pad with soft stuff either. Just a
     list — consolidate writes them, not this skill.
   - *How to proceed*, as options, e.g.:
     `a) continue with <X>  ·  b) tighten scope to <Y>  ·  c) break → fresh session  ·  d) consolidate now`

That's it. On "break" → consolidate first (log + handoff), then continue in a
fresh session. On "consolidate" → hand into that skill (which re-judges the
candidates properly before any write).

## Guardrails
- Read-only. The checkpoint never writes engrams — it proposes, consolidate persists.
- If it feels heavy, cut back to sorting + the one "how to proceed" prompt.
- Chat picture follows the conversation language; brain candidates are phrased in
  English (consolidate needs them that way).
