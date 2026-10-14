// Client-side API wrapper. All calls go to the host proxy (/api/brain/*), never
// directly to the brain API — the token lives host-side only. Ported from
// packages/web/lib/api.ts (config-endpoint helpers dropped: the host auto-provisions).

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

/** GET a brain-relative path via the proxy. `path` excludes the /api/brain prefix. */
export async function brainGet<T>(
  path: string,
  params?: Record<string, string | number | undefined>,
): Promise<T> {
  const qs = new URLSearchParams();
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") qs.set(k, String(v));
    }
  }
  const suffix = qs.toString() ? `?${qs}` : "";
  const res = await fetch(`/api/brain${path}${suffix}`, {
    headers: { Accept: "application/json" },
  });
  return parse<T>(res);
}

/** POST a brain-relative path via the proxy. */
export async function brainPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/brain${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parse<T>(res);
}
