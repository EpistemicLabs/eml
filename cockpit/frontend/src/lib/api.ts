// Client-side API wrapper. All calls go to the host proxy (/api/brain/*), never
// directly to the brain API — the token lives host-side only. Ported from
// packages/web/lib/api.ts (config-endpoint helpers dropped: the host auto-provisions).
import { SPACE_HEADER } from "./space-header";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isNotConnected(err: unknown): boolean {
  return err instanceof ApiError && err.status === 428;
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message =
      (data && (data.error as string)) || `Request failed (${res.status})`;
    throw new ApiError(res.status, message);
  }
  return data as T;
}

/** `space` names the brain space a request means; without it the open one's (space-fetch.ts). */
const spaceHeaders = (space?: string): Record<string, string> =>
  space ? { [SPACE_HEADER]: space } : {};

/** GET a brain-relative path via the proxy. `path` excludes the /api/brain prefix. */
export async function brainGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
  space?: string,
): Promise<T> {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await fetch(`/api/brain${path}${suffix}`, {
    headers: { Accept: "application/json", ...spaceHeaders(space) },
  });
  return parse<T>(res);
}

/** POST a brain-relative path via the proxy. */
export async function brainPost<T>(path: string, body: unknown, space?: string): Promise<T> {
  const res = await fetch(`/api/brain${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...spaceHeaders(space) },
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}
