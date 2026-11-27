// A worker the host could not start: every session runs in the chat, so it says why instead of falling back to a terminal.
/**
 * Why a claimed worker did not open, for the desk's toast; null when there is nothing to tell (another tab took
 * it, it is no longer needed, or it waits for room and the host starts it later).
 */
export function spawnProblem(error: { code?: string; message?: string } | undefined): string | null {
  if (!error || error.code === 'ALREADY_CLAIMED' || error.code === 'REVOKED' || error.code === 'NO_ROOM') return null;
  return `A worker session could not start: ${error.message ?? 'the cockpit host gave no reason.'}`;
}
