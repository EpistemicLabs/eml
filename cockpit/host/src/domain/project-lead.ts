/**
 * The project lead (decision tasks-view-by-project-with-daily-project-lead):
 * one session per project and day that knows the project's state from the
 * brain, plans the day with the user and hands out the work. It works on no
 * task of its own; what it leaves for tomorrow's lead is the project's status.
 * A new day gets a fresh lead: the continuity is in the brain, not the chat.
 */

export interface ProjectLead {
  /** The cockpit project it leads (registry id, bp-<brain id>). */
  projectId: string
  /** The day it leads, in the user's time zone (YYYY-MM-DD). */
  day: string
}

/** The day in a time zone, as YYYY-MM-DD. */
export function leadDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** The lead's first message: what it reads, what it proposes, how it hands out work. */
export function leadPrompt(project: { name: string; brainId: string | null }, day: string): string {
  const scope = project.brainId ? `project.${project.brainId}` : null
  return [
    `You are the project lead of "${project.name}" for today, ${day}.`,
    '',
    'First read where the project stands, without changing anything:',
    scope
      ? `- eml_show ${scope}: its status (yesterday's lead left it there), open tasks and latest session.`
      : '- the project has no brain project: read its folder and ask the user what matters.',
    scope ? `- eml_list type=task scope=${scope} with status=active and status=planned; for the ones that matter, eml_get to read their journal (handoffs, waiting on).` : '',
    '',
    'Then give the user a short day plan, in this order:',
    '1. Waiting on you: what needs the user\'s answer or go, with the question.',
    '2. Running: what sessions work on right now.',
    '3. Due or overdue.',
    '4. My proposal for today: three to five things, the most important first, and how each would run (a worker, a step with a checkpoint, or the user himself).',
    'Ask the user to decide. Do not start anything before he does.',
    '',
    'When he has decided, hand out the work:',
    '- a worker on an existing task: cockpit-spawn with --task <id>; one without a task yet: --new-task "<title>" --in <project>.',
    '- planned steps of a task: eml_create_task with parent_id, depends_on and checkpoint (before · after · none); the runner starts them.',
    'You work on no task of your own. Keep track of the day here and in the tasks\' journals.',
    '',
    scope
      ? `When the user says the day is done, or the cockpit asks before it stops this session, write the project's status (eml_set_status scope=${scope}): what moved today, what waits on whom, what tomorrow's lead should start with.`
      : 'When the user says the day is done, sum up what moved and what is next.',
  ].filter((line, i, all) => line !== '' || all[i - 1] !== '').join('\n')
}

/** What the cockpit asks a lead before it stops it for being idle. */
export const LEAD_HANDOFF = 'The cockpit is about to stop this session because nobody has used it for a while. Before it does, write the project\'s status now (eml_set_status for this project): what moved today, what waits on whom, what tomorrow\'s lead should start with. Nothing else; the session stops after this reply.'
