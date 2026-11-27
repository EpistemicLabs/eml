/** The host's answer to POST /api/spawn as cockpit-spawn reads it (spawn-api.ts SpawnOutcome). */
export interface SpawnAnswer {
  id?: string
  projectId?: string
  address?: string
  taskId?: string
  routed?: boolean
}

/**
 * What cockpit-spawn (spawn-cli.ts) prints for an answer, one entry per line. A routed answer started no worker: the
 * task's session got the prompt as a message, and the lines name it. `open`: the worker was asked for with a pane.
 */
export function spawnAnswerLines(answer: SpawnAnswer, { open }: { open: boolean }): string[] {
  if (answer.routed) {
    return [
      `No worker started: task ${answer.taskId} already has its session ${answer.id}, and a task has one session at a time. Your prompt went to that session as a message.`,
      ...(answer.address ? [`Its address: ${answer.address} (for SendMessage and notify_when_idle).`] : []),
    ]
  }
  return [
    open
      ? `Worker requested in project ${answer.projectId} — it opens as a new pane next to this session; with no cockpit tab open, the host starts it on its own within seconds and it shows in the sidebar.`
      : `Worker requested in project ${answer.projectId} — it runs without a pane and shows in the sidebar under this session. It starts as soon as the machine has room.`,
    ...(answer.address ? [`Worker address: ${answer.address} (for SendMessage and notify_when_idle).`] : []),
    ...(answer.taskId ? [`Its task: ${answer.taskId}`] : []),
  ]
}
