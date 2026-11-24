/**
 * One start per task at a time. Several clients (panes, tabs, a phone) can ask for a session on the same task
 * at once, each before the others' session shows in its lists; the page's own guard only covers one client.
 * A start with the same task and prompt
 * inside the window, or while one is still being decided, gets the first one's answer instead of a session
 * of its own. A refused start is forgotten at once, so a retry after fixing the cause goes through.
 */

export const START_WINDOW_MS = 30_000

export function createStartGate<T extends { ok: boolean }>(now: () => number = Date.now) {
  const starts = new Map<string, { at: number; result: Promise<T> }>()
  return (key: string, start: () => Promise<T>): Promise<T> => {
    const at = now()
    for (const [k, s] of starts) if (at - s.at >= START_WINDOW_MS) starts.delete(k)
    const recent = starts.get(key)
    if (recent) return recent.result
    const result = start()
    starts.set(key, { at, result })
    void result.then((r) => { if (!r.ok && starts.get(key)?.result === result) starts.delete(key) }, () => { if (starts.get(key)?.result === result) starts.delete(key) })
    return result
  }
}
