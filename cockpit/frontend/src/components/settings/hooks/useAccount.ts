// The EML account as the host reports it (GET /api/account) and the actions
// Settings › Account offers: start a sign-in with an email, finish it with
// the mailed code, sign out. The session never reaches the browser; every
// call goes through the host's /api/account routes.
import { useCallback, useEffect, useState } from 'react';

export type AccountBrain = { brain: string; created_at: string; members: number };

export type AccountStatus =
  | { signedIn: false; url: string }
  | {
      signedIn: true;
      url: string;
      email: string;
      /** 'unavailable' when the host could not reach the service; account, beta and brains are then unknown. */
      service: 'ok' | 'unavailable';
      account: string | null;
      beta: boolean;
      brains: AccountBrain[] | null;
    };

export type SignInStep = 'email' | 'code';

type HostError = { error?: { code?: string; message?: string } };

async function hostError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as HostError;
    if (body.error?.message) return body.error.message;
  } catch {
    /* no JSON body */
  }
  return `The cockpit answered ${res.status}.`;
}

export function useAccount() {
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [step, setStep] = useState<SignInStep>('email');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/account');
      if (!res.ok) throw new Error(`${res.status}`);
      setStatus((await res.json()) as AccountStatus);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const post = useCallback(async (path: string, body?: unknown): Promise<Response | null> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        setError(await hostError(res));
        return null;
      }
      return res;
    } catch {
      setError('The cockpit could not be reached.');
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  /** Asks the service to mail a code; the answer is the same whether the email is known or not. */
  const sendCode = useCallback(async (email: string) => {
    if (await post('/api/account/signin', { email })) setStep('code');
  }, [post]);

  /** Finishes the sign-in with the mailed code. */
  const signIn = useCallback(async (code: string) => {
    const res = await post('/api/account/code', { code });
    if (res) {
      setStatus((await res.json()) as AccountStatus);
      setStep('email');
    }
  }, [post]);

  const signOut = useCallback(async () => {
    const res = await post('/api/account/signout');
    if (res) setStatus((await res.json()) as AccountStatus);
  }, [post]);

  /** Back to the email field, for another address or a new code. */
  const restart = useCallback(() => { setStep('email'); setError(null); }, []);

  return { status, failed, step, busy, error, refresh, sendCode, signIn, signOut, restart };
}
