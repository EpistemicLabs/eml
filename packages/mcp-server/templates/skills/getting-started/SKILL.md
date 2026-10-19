---
name: getting-started
description: First-run onboarding for a fresh EML brain — a short guided start. Gets to know the user and fills their profile, creates their first project with a status and a few open tasks, then explains the brain on that project (engram types, scopes) and — in the EML cockpit — lets the user look at it in the Brain tab and explains sidebar, working folders and desks, then shows the agent's default rules and the skills. In the cockpit it ends by asking for the project's working folder, consolidating, and handing over to a new session in the project. The cockpit starts it in the first session of a new brain; invoke it on "getting started", "onboarding", "set up my brain", "erste Schritte", "einrichten".
---
<!-- managed-by: engramprotocol-setup -->

# getting-started

The user has just set up their brain. This is their first conversation with you.
Make it warm and useful: in a few minutes they should have a brain that knows
who they are and what they work on, understand what is in it, and have seen it
remember something.

**Show, don't list.** Explain the brain on the user's own first project, not in
the abstract: create it first, then walk through what they see.

**Pace:** one question at a time. If the user wants to skip a step or stop,
do so — nothing here is mandatory. Brain writes are routine: write, then say in
one line what you stored.

**Language and tone:** answer in the language the user writes in, casual and
on first-name terms by default. Don't ask about either; if they want it
otherwise, switch and note it in their profile. Keep the product's terms as
they are — brain, engram, scope, desk, task run — the app shows them in
English.

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

2. **Get to know the user.** Ask what they're working on and what they want
   to use you for — one question, so the answer says where you come in, not
   just what keeps them busy. Ask about their role only if the answer leaves
   it open. Don't ask about language, tone or how long your answers should be
   — see above, and step 6 for the length.

   Update their profile engram (`<user>-identity`, scope `user.<user>`): read
   it with `eml_get`, replace the placeholder line "The agent learns more from
   conversation…" with what you learned, written in English as plain facts,
   and send the whole new text with `eml_update` — `content` replaces the
   engram's content completely, so keep its first line. A profile holds at
   most 400 characters: keep it to the core facts. If they said what they
   want you for, add one line about that role to your identity engram
   (`<agent>-identity`) the same way.

3. **The first project.** Ask what they'd like to start with — the thing they
   named in step 2 is the obvious candidate. Then:
   - Create it with `eml_project_create` (a short kebab-case id, a readable name).
   - Set its current state with `eml_set_status` (one or two sentences).
   - Ask for the next one to three concrete things to do, and store each with
     `eml_track_task` in the project's scope. Don't set a priority they
     didn't give.

4. **The brain.** Call `eml_show project.<id>` and present the result in a
   few lines, in the user's language (the engrams stay English): "This is
   what your next session will see." Then explain the
   brain on it, one or two lines per point:
   - **Engrams** are the entries in the brain, each with a type. Name the two
     they now have — the *status* (the current state; a new one replaces the
     old) and the *tasks* (open work, from idea to done) — then the others
     that come with time:
     - *decision* — a choice between real alternatives, with the reason;
     - *note* — a thought that lives in the brain, plus a few special kinds:
       *rule* (a way of working, like the ones in step 6), *profile* (who
       someone is — like the one you just filled in), *event* (something that
       happened), *reference* (a link to something outside), *log* (a session
       summary).
   - **Scopes** say what an engram is about: this project, a person or
     organisation (entity), the user, the agent, or global.

   *Cockpit:* let them see it for themselves. Ask them to open the **Brain
   tab** — the first tab in the desk bar, with a brain icon and the space's
   name ("Main" at first) — and walk them through it:
   - the dashboard: search, open tasks, recent activity and all projects;
   - clicking their project opens its page: status, open tasks, decisions and
     a graph of its engrams;
   - clicking a task opens its details; there, **"Advance task"** starts a
     task run — a session that works the task through stage by stage and
     stops for their go after each stage.

   They come back here through the desk tab next to it. Then a quick "any
   questions?".

5. *Cockpit only —* **The cockpit.** A message of its own, a few lines:
   - **Sidebar:** their projects, each with its sessions below it. A
     project's "+" starts a new agent session in it (e.g. "New Claude Code
     session" — the label names the agent CLI), a "New brain view" or a
     "New note".
   - **Working folder:** every project has a working folder. Its sessions
     start there, and that is where you read and write files — code,
     documents. They can link a folder of their own with the project's folder
     button in the sidebar; otherwise the cockpit makes one.
   - **Desks:** the tabs next to the Brain tab; each desk holds its own panes,
     several sessions side by side. ⌘K (Ctrl+K) opens the command palette for
     everything else.

   End with a quick "any questions?" and wait for the answer before step 6.

6. **Your own identity and style.** Show the user, briefly, how you're set up to
   work — your default rules:
   - verify before asserting, or say that something is an assumption;
   - engage as a peer, not a cheerleader: name risks, give reasons;
   - detailed answers by default — explain the reasoning and context; if they
     want it shorter, they just say so;
   - propose before non-trivial changes, and act after their go.

   Ask whether that fits. On a change, update the matching rule with
   `eml_update` (the answer length lives in `<agent>-engagement-style`).

7. **Skills and asking.** Two or three lines:
   - **Skills** are routines they can call with a slash command:
     - `/checkpoint` — sorts a long session when it starts to drift;
     - `/consolidate` — at the end of a session, stores what's worth keeping;
     - `/getting-started` — this tour, any time again.

     *Cockpit:* also `/spawn-session` — it opens a parallel worker session
     next to this one; and `/report-issue` — sends a bug or a wish for EML
     to its makers as a GitHub issue.
   - **Asking** works in plain language: "where do we stand on X?" or "what did
     we decide about Y?" — you look it up in the brain instead of guessing.

8. **Close.** One or two sentences: the brain is set up, and they can start on
   the first task.

   *Cockpit:* this session runs in a cockpit-made "Getting started" folder,
   not in their project — the work goes on in a new session there:
   1. **Working folder.** Ask whether the project's work lives in a folder on
      this computer. If yes, ask them to link it now with the project's folder
      button in the sidebar, and wait until they say it's done. If not, the
      cockpit makes one.
   2. **Consolidate.** Run the `consolidate` skill in auto mode — they are new
      to this, so don't ask them to approve a diff, and skip its report
      format (no "approve · edit · undo" line). Instead say in plain words what
      you stored and what it is for, e.g. "a log: a short summary of this
      session, which the next session reads to pick up where we left off".
      If consolidate held something back, ask about it in plain words instead
      of showing its HELD BACK list.
   3. **Hand over.** With the `spawn-session` skill, open a session in the
      project (`--project <id>`, the project's name as title) with this
      prompt: "Load the brain for project <id> (eml_show project.<id>). Say in
      a few lines where we stand and which tasks are open, then ask which one
      to start with."
   4. Tell them the new session opens next to this one and the work goes on
      there; this one can be closed.

## Guardrails
- Keep it moving. If the user gives one-word answers, don't press for more.
- Write only what the user told you. Don't invent facts for their profile, and
  don't create projects or tasks they didn't ask for.
- Describe only what you know is there. In the cockpit, stick to the places
  named in steps 4 and 5; don't guess at other buttons or menus.
- Engram content is English; the conversation follows the user's language.
- Their name and your name are fixed handles of the brain. If they want to be
  called differently, put that in their profile; the ids stay as they are.
