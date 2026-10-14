import { useEffect, useState, type FormEvent, type ReactNode } from "react";

/**
 * First-run setup (host: setup.ts). While the home has no brain, the host
 * serves only this screen: the user names themselves and their agent, the host
 * provisions the brain with those names and hands its port over to the real
 * cockpit; this page waits for it and reloads into the app.
 */

type SetupState = "checking" | "needed" | "ready";

type SetupStatus = { needed?: boolean; signIn?: boolean };

async function setupStatus(): Promise<SetupStatus> {
  const response = await fetch("/api/setup");
  return (await response.json()) as SetupStatus;
}

async function setupNeeded(): Promise<boolean> {
  return (await setupStatus()).needed === true;
}

/**
 * Right after the setup Claude is not signed in yet: open Settings › Models,
 * whose Sign in button starts a /login session. The host opens the
 * getting-started session once the sign-in is done.
 */
export function useFirstRunSignIn(openSettings: (tab?: string) => void): void {
  useEffect(() => {
    setupStatus()
      .then((status) => { if (status.signIn) openSettings("models"); })
      .catch(() => { /* older host or host gone — nothing to do */ });
  }, [openSettings]);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the real host answers (the setup server is gone), then reload. */
async function reloadWhenHostIsUp(): Promise<void> {
  for (;;) {
    await sleep(500);
    try {
      if (!(await setupNeeded())) break;
    } catch { /* port is changing hands */ }
  }
  window.location.reload();
}

export function FirstRunGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SetupState>("checking");
  useEffect(() => {
    setupNeeded()
      .then((needed) => setState(needed ? "needed" : "ready"))
      .catch(() => setState("ready"));
  }, []);
  if (state === "checking") return null;
  if (state === "needed") return <FirstRun />;
  return <>{children}</>;
}

function FirstRun() {
  const [userName, setUserName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userName, agentName }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(body.error?.message ?? `Setup failed (${response.status})`);
      }
      await reloadWhenHostIsUp();
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  };

  const field = "w-full rounded-md border border-input bg-background px-3 py-2 text-body text-foreground outline-none focus:border-ring";

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <form onSubmit={submit} className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6">
        <div className="space-y-1.5">
          <h1 className="text-heading font-semibold">Welcome to EML</h1>
          <p className="text-ui text-muted-foreground">
            Your agent keeps a memory of your work in a brain on this computer. Two names to start. Next you sign
            in to Claude, then your agent takes you through the rest.
          </p>
        </div>
        <label className="block space-y-1.5">
          <span className="text-ui text-muted-foreground">Your name</span>
          <input className={field} value={userName} onChange={(e) => setUserName(e.target.value)} autoFocus maxLength={60} disabled={submitting} />
        </label>
        <label className="block space-y-1.5">
          <span className="text-ui text-muted-foreground">Your agent's name</span>
          <input className={field} value={agentName} onChange={(e) => setAgentName(e.target.value)} placeholder="e.g. Juno" maxLength={60} disabled={submitting} />
        </label>
        <p className="text-caption text-muted-foreground">
          The names become your brain's handles and can't be changed later.
        </p>
        {error && <p className="text-ui text-primary">{error}</p>}
        <button
          type="submit"
          disabled={submitting || !userName.trim() || !agentName.trim()}
          className="w-full rounded-md bg-primary px-3 py-2 text-body font-medium text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "Setting up your brain…" : "Create brain"}
        </button>
      </form>
    </div>
  );
}
