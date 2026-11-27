// The terminal fallback (Settings › Advanced): every session runs in the chat; while this cockpit-wide
// switch is on, a session can also be opened in its agent's own terminal, for debugging. Host:
// GET/PATCH /api/terminal-fallback → { enabled }. While it is off the host attaches no PTY to an agent
// session and answers the terminal's init with the error code TERMINAL_FALLBACK_OFF.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';

import { closeAllTerminalFallbacks } from '@/stores/usePaneStore';

export const TERMINAL_FALLBACK_OFF = 'TERMINAL_FALLBACK_OFF';

const key = ['terminal-fallback'] as const;

async function request(init?: RequestInit): Promise<boolean> {
  const res = await fetch('/api/terminal-fallback', init);
  const body = await res.json().catch(() => null) as { enabled?: unknown; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body?.enabled === true;
}

/** Whether the terminal fallback is on. Off until the host has answered, and off on a host that does not know it. */
export function useTerminalFallback(): boolean {
  return useQuery({ queryKey: key, queryFn: () => request(), staleTime: 60_000 }).data === true;
}

/** The switch as Settings shows it: its state (undefined while loading) and a setter. */
export function useTerminalFallbackSwitch() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: key, queryFn: () => request(), staleTime: 60_000 });
  const mutation = useMutation({
    mutationFn: (enabled: boolean) =>
      request({ method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) }),
    onSuccess: (enabled) => qc.setQueryData(key, enabled),
  });
  return { enabled: query.data, failed: query.isError, set: mutation.mutate, pending: mutation.isPending, error: mutation.error };
}

/** A pane in the fallback goes back to the chat once the switch is off (here, in another tab, or on the host). */
export function useCloseFallbacksWhenOff(): void {
  const query = useQuery({ queryKey: key, queryFn: () => request(), staleTime: 60_000 });
  const off = query.isSuccess && query.data === false;
  useEffect(() => {
    if (off) closeAllTerminalFallbacks();
  }, [off]);
}

/** Whether a frame or message from the host says the fallback is off. */
export function isFallbackOff(frame: { code?: unknown; message?: unknown }): boolean {
  return frame.code === TERMINAL_FALLBACK_OFF || (typeof frame.message === 'string' && frame.message.includes(TERMINAL_FALLBACK_OFF));
}
