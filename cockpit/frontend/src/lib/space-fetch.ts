// Every host request works in the active brain space: the host reads it from
// the `x-cockpit-space` header (missing = main). Installed once at startup,
// this wraps window.fetch so the ~40 call sites (brain proxy, projects,
// sessions, notes, brain-info, …) need no change. Only same-origin /api/
// requests get the header; /api/spaces itself is space-independent.
import { getActiveSpaceId } from '@/stores/usePaneStore';

export const SPACE_HEADER = 'x-cockpit-space';

const isHostApi = (input: RequestInfo | URL): boolean => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return url.startsWith('/api/') || url.startsWith(`${window.location.origin}/api/`);
};

export function installSpaceHeader(): void {
  const original = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const space = getActiveSpaceId();
    if (!space || !isHostApi(input)) return original(input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(SPACE_HEADER, space);
    return original(input, { ...init, headers });
  };
}
