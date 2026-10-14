---
name: getting-started
description: First-run onboarding for a fresh EML brain — a short guided start. Explains what the brain is and how it is organised (engram types, scopes, skills), fills the user's profile from a brief conversation, shows the agent's default rules, creates the user's first project with a status and a few open tasks, and shows that the brain remembers. The cockpit starts it in the first session of a new brain; invoke it on "getting started", "onboarding", "set up my brain", "erste Schritte", "einrichten".
---
<!-- managed-by: engramprotocol-setup -->

# getting-started

The user has just set up their brain. This is their first conversation with you.
Make it warm and useful: in a few minutes they should understand what the brain
is, have a brain that knows who they are and what they work on, and have seen it
remember something.

**Pace:** one question at a time, in the user's language. If the user wants to
skip a step or stop, do so — nothing here is mandatory. Brain writes are
routine: write, then say in one line what you stored.

## Steps

1. **Greet and explain the brain** (3 sentences, no more). Call `eml_boot` first
   so you know your name and theirs. Then say, in your own words:
   - You keep a memory of your work together in a brain on this computer —
     decisions, tasks, project state, how they like to work.
   - The brain belongs to them; every session starts by loading it, so you pick
     up where you left off instead of starting from zero.
   - Ask whether they're ready for a few quick questions.

2. **Get to know the user.** Ask, one at a time:
   - What they do (role, field) and what they're mainly working on right now.
   - Which language they want to work in, and whether they prefer a formal or a
     casual tone.

   Don't ask how long your answers should be — detailed is the default (step 3).

   Update their profile engram (`<user>-identity`, scope `user.<user>`) with
   `eml_update`: replace the placeholder line "The agent learns more from
   conversation…" with what you learned, written in English as plain facts.

3. **Your own identity and style.** Show the user, briefly, how you're set up to
   work — your default rules:
   - verify before asserting, or say that something is an assumption;
   - engage as a peer, not a cheerleader: name risks, give reasons;
   - detailed answers by default — explain the reasoning and context; if they
     want it shorter, they just say so;
   - propose before non-trivial changes, and act after their go.

   Ask whether that fits. On a change, update the matching rule with
   `eml_update` (the answer length lives in `<agent>-engagement-style`). Add one
   line to your identity engram (`<agent>-identity`) if they told you something
   about the role they want you in.

4. **How the brain is organised.** A short tour, one or two lines per point,
   then a quick "any questions?":
   - **Engrams** are the entries in the brain, each with a type:
     - *decision* — a choice between real alternatives, with the reason;
     - *status* — the current state of a project (a new one replaces the old);
     - *task* — open work, from idea to done;
     - *note* — a thought that lives in the brain, plus a few special kinds:
       *rule* (a way of working, like the ones in step 3), *profile* (who
       someone is), *event* (something that happened), *reference* (a link to
       something outside), *log* (a session summary).
   - **Scopes** say what an engram is about: a project, a person or
     organisation (entity), the user, the agent, or global.
   - **Skills** are routines they can call with a slash command:
     - `/checkpoint` — sorts a long session when it starts to drift;
     - `/consolidate` — at the end of a session, stores what's worth keeping;
     - `/getting-started` — this tour, any time again.

     If you are running in the EML cockpit, also mention `/spawn-session`: it
     opens a parallel worker session next to this one.
   - **Asking** works in plain language: "where do we stand on X?" or "what did
     we decide about Y?" — you look it up in the brain instead of guessing.

5. **The first project.** Ask what they'd like to start with — the thing they
   named in step 2 is the obvious candidate. Then:
   - Create it with `eml_project_create` (a short kebab-case id, a readable name).
   - Set its current state with `eml_set_status` (one or two sentences).
   - Ask for the next one to three concrete things to do, and store each with
     `eml_track_task` in the project's scope.

6. **Show that it remembers.** Call `eml_show project.<id>` and present the result
   in a few lines: "This is what your next session will see." Point out the
   types from step 4 in it — the status, the open tasks.

7. **Close.** One or two sentences: the brain is set up, and this session can
   simply continue with the first task. If you're running in the EML cockpit,
   mention that the project now shows up in the sidebar, where they can start
   sessions in it (and link it to a folder).

## Guardrails
- Keep it moving. If the user gives one-word answers, don't press for more.
- Write only what the user told you. Don't invent facts for their profile, and
  don't create projects or tasks they didn't ask for.
- Engram content is English; the conversation follows the user's language.
- Their name and your name are fixed handles of the brain. If they want to be
  called differently, put that in their profile; the ids stay as they are.
