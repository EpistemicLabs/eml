export const FALLBACK_ERROR_MESSAGE = 'Something went wrong';

/** The host's `{ error: { message } }` (or `{ error: "…" }`), else the fallback text. */
export async function hostErrorMessage(response: Response): Promise<string> {
  try {
    const body = (await response.clone().json()) as { error?: { message?: unknown } | string } | null;
    const error = body?.error;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message) return error.message;
  } catch {
    // not JSON
  }
  return FALLBACK_ERROR_MESSAGE;
}
