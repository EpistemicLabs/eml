---
name: getting-started
description: First-run onboarding for a fresh EML brain — a short guided start. Gets to know the user and fills their profile, creates their first project with a status and a few open tasks, then explains the brain on that project (engram types, scopes) and — in the EML cockpit — where it shows up in the app, shows the agent's default rules and the skills. The cockpit starts it in the first session of a new brain; invoke it on "getting started", "onboarding", "set up my brain", "erste Schritte", "einrichten".
---
<!-- managed-by: engramprotocol-setup -->

# getting-started

The user has just set up their brain. This is their first conversation with you.
Make it warm and useful: in a few minutes they should have a brain that knows
who they are and what they work on, understand what is in it, and have seen it
remember something.

**Show, don't list.** Explain the brain on the user's own first project, not in
the abstract: create it first, then walk through what they see.

**Pace:** one question at a time, in the user's language. If the user wants to
skip a step or stop, do so — nothing here is mandatory. Brain writes are
routine: write, then say in one line what you stored.

**In the EML cockpit?** If the `/spawn-session` skill is available to you, you
are running in the EML cockpit (a web app with a sidebar, desks and panes);
the parts marked *Cockpit* apply. Otherwise skip them — everything else works
with any MCP client.

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

   Don't ask how long your answers should be — detailed is the default (step 5).

   Update their profile engram (`<user>-identity`, scope `user.<user>`) with
   `eml_update`: replace the placeholder line "The agent learns more from
   conversation…" with what you learned, written in English as plain facts.

3. **The first project.** Ask what they'd like to start with — the thing they
   named in step 2 is the obvious candidate. Then:
   - Create it with `eml_project_create` (a short kebab-case id, a readable name).
   - Set its current state with `eml_set_status` (one or two sentences).
   - Ask for the next one to three concrete things to do, and store each with
     `eml_track_task` in the project's scope.

4. **What's in the brain now.** Call `eml_show project.<id>` and present the
   result in a few lines: "This is what your next session will see." Then
   explain the brain on it, one or two lines per point:
   - **Engrams** are the entries in the brain, each with a type. Name the two
     they now have — the *status* (the current state; a new one replaces the
     old) and the *tasks* (open work, from idea to done) — then the others
     that come with time:
     - *decision* — a choice between real alternatives, with the reason;
     - *note* — a thought that lives in the brain, plus a few special kinds:
       *rule* (a way of working, like the ones in step 5), *profile* (who
       someone is — like the one you just filled in), *event* (something that
       happened), *reference* (a link to something outside), *log* (a session
       summary).
   - **Scopes** say what an engram is about: this project, a person or
     organisation (entity), the user, the agent, or global.

   *Cockpit:* then show where it lives in the app, in a few lines:
   - **Sidebar:** the project is listed there. Its "+" starts a new session in
     it ("New Claude Code session"), opens a "New brain view" or a "New note".
     The project's folder button links it to a folder of their own, so its
     sessions start there.
   - **Brain tab:** the first tab in the desk bar opens the brain dashboard —
     search, open tasks, recent activity and all projects. A project's page
     shows its status, open tasks, decisions and a graph.
   - **Task runs:** clicking a task there opens it; "Advance task" starts a
     session that works it through stage by stage and stops for their go after
     each stage.
   - **Desks:** the tabs next to the brain tab; each desk holds its own panes,
     several sessions side by side. ⌘K (Ctrl+K) opens the command palette for
     everything else.

   Then a quick "any questions?".

5. **Your own identity and style.** Show the user, briefly, how you're set up to
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

6. **Skills and asking.** Two or three lines:
   - **Skills** are routines they can call with a slash command:
     - `/checkpoint` — sorts a long session when it starts to drift;
     - `/consolidate` — at the end of a session, stores what's worth keeping;
     - `/getting-started` — this tour, any time again.

     *Cockpit:* also `/spawn-session` — it opens a parallel worker session
     next to this one.
   - **Asking** works in plain language: "where do we stand on X?" or "what did
     we decide about Y?" — you look it up in the brain instead of guessing.

7. **Close.** One or two sentences: the brain is set up, and this session can
   simply continue with the first task.

## Guardrails
- Keep it moving. If the user gives one-word answers, don't press for more.
- Write only what the user told you. Don't invent facts for their profile, and
  don't create projects or tasks they didn't ask for.
- Describe only what you know is there. In the cockpit, stick to the places
  named in step 4; don't guess at other buttons or menus.
- Engram content is English; the conversation follows the user's language.
- Their name and your name are fixed handles of the brain. If they want to be
  called differently, put that in their profile; the ids stay as they are.
