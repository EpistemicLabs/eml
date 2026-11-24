/**
 * A session's name: a session with a named task is called by its task, so the
 * heading, the sidebar, the tasks card and the chat say the same; renaming one renames the task. Only a session
 * without a task, or whose task has no name yet, goes by its own: the title the user gave, the one the agent gave,
 * else what the transcript offers.
 */
export function sessionName(
  entry: { taskId: string | null; title: string | null; agentTitle: string | null },
  taskName: string | null,
  transcript: string,
): string {
  if (entry.taskId && taskName) return taskName
  return entry.title ?? entry.agentTitle ?? transcript
}
