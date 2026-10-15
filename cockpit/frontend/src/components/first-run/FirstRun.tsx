import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

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
 * Step 2 of the first run, in the real cockpit: right after the setup Claude
 * is not signed in yet (GET /api/setup → signIn). A card with one button opens
 * a session that runs Claude Code's own /login; the host opens the
 * getting-started session once the sign-in is done (onboarding.ts). The card
 * is the only way on: no shortcut past the onboarding (the setup-token stays
 * in Settings › Models for later).
 */
export function FirstRunSignIn() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { runtime, retry, failures } = useClaudeRuntime(open);

  useEffect(() => {
    setupStatus()
      .then((status) => { if (status.signIn) setOpen(true); })
      .catch(() => { /* older host or host gone — nothing to do */ });
  }, []);

  if (!open) return null;
  const ready = runtime.version !== null;

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/agents/login/session", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: null }),
      });
      if (!response.ok) throw new Error();
      setOpen(false);
    } catch {
      setError("Could not open the sign-in session. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/20 p-4 backdrop-blur-md">
      <div role="dialog" aria-modal="true" aria-labelledby="first-run-sign-in" className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6">
        <div className="space-y-1.5">
          <p className="text-caption text-muted-foreground">Step 2 of 2</p>
          <h1 id="first-run-sign-in" className="text-heading font-semibold">Connect Claude</h1>
          <p className="text-ui text-muted-foreground">
            Your agent runs on Claude Code with your Claude subscription. Signing in opens a terminal with Claude
            Code's own sign-in. Once you're signed in, your agent starts and takes you through the rest.
          </p>
        </div>
        <p className="text-caption text-muted-foreground">
          The sign-in belongs to this cockpit only; a Claude Code you already use on this computer is not touched.
          Codex can be added later in Settings › Models (beta).
        </p>
        {!ready && (
          <p className="text-ui text-muted-foreground">
            {runtime.failed
              ? `The download failed: ${runtime.failed}`
              : "A one-time download of Claude Code into the cockpit, usually under a minute."}
          </p>
        )}
        {error && <p className="text-ui text-primary">{error}</p>}
        {runtime.failed && failures >= 2 && (
          <div className="space-y-1.5 text-caption text-muted-foreground">
            <p>
              It keeps failing. The download comes from Anthropic's servers — check the internet connection, and a
              proxy or firewall that might block it.
            </p>
            <p>
              If that's not it, please{" "}
              <a href={ISSUES_URL} target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-2">
                report the problem
              </a>{" "}
              with the error above and the host log (<code className="font-mono">host.log</code> in the cockpit home,
              by default <code className="font-mono">~/.eml-cockpit</code>).
            </p>
          </div>
        )}
        {runtime.failed ? (
          <button
            type="button"
            onClick={() => void retry()}
            autoFocus
            className="w-full rounded-md bg-primary px-3 py-2 text-body font-medium text-primary-foreground"
          >
            Try again
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void signIn()}
            disabled={busy || !ready}
            autoFocus
            className="w-full rounded-md bg-primary px-3 py-2 text-body font-medium text-primary-foreground disabled:opacity-50"
          >
            {busy ? "Opening…" : ready ? "Sign in to Claude" : "Downloading Claude Code to the cockpit…"}
          </button>
        )}
      </div>
    </div>
  );
}

type ClaudeRuntime = { version: string | null; failed: string | null };

const ISSUES_URL = "https://github.com/EpistemicLabs/eml/issues";

/**
 * The cockpit's own Claude Code, which a fresh home downloads at the first
 * start: a sign-in before it is installed would end in "not set up yet".
 * Polls /api/providers while `active` until a version is there; `retry`
 * starts a failed download again.
 */
function useClaudeRuntime(active: boolean): { runtime: ClaudeRuntime; retry: () => Promise<void>; failures: number } {
  const [runtime, setRuntime] = useState<ClaudeRuntime>({ version: null, failed: null });
  // Failed attempts seen: the first download plus every Try again that failed.
  const [failures, setFailures] = useState(0);
  // Results older than the last Try again belong to the attempt before it.
  const retriedAt = useRef(0);
  const lastFailureAt = useRef<string | null>(null);
  useEffect(() => {
    if (!active || runtime.version) return;
    let stopped = false;
    const check = async () => {
      try {
        const body = (await (await fetch("/api/providers")).json()) as {
          providers?: Array<{ id: string; version: string | null; runtime?: { lastResult?: { at?: string; outcome?: string; error?: string } | null } }>;
        };
        const claude = body.providers?.find((provider) => provider.id === "claude");
        if (stopped || !claude) return;
        const last = claude.runtime?.lastResult;
        // Only a failed first download blocks; a failed update keeps the old version.
        const current = last?.at !== undefined && Date.parse(last.at) >= retriedAt.current;
        const failed = !claude.version && current && last?.outcome === "failed" ? last.error ?? "unknown error" : null;
        if (failed && last?.at !== lastFailureAt.current) {
          lastFailureAt.current = last?.at ?? null;
          setFailures((n) => n + 1);
        }
        setRuntime({ version: claude.version, failed });
      } catch { /* host busy — next round */ }
    };
    void check();
    const timer = setInterval(() => void check(), 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [active, runtime.version]);

  // A failed download: run the runtime check again (Settings › Models ›
  // Check now does the same); polling picks up the outcome.
  const retry = async () => {
    retriedAt.current = Date.now();
    setRuntime({ version: null, failed: null });
    await fetch("/api/providers/claude/runtime/check", { method: "POST" }).catch(() => undefined);
  };
  return { runtime, retry, failures };
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
          <p className="text-caption text-muted-foreground">Step 1 of 2</p>
          <h1 className="text-heading font-semibold">Welcome to EML</h1>
          <p className="text-ui text-muted-foreground">
            EML gives your AI agent a memory. It keeps what you decide, what's open and how you like to work in a
            brain, and loads it at the start of every session, so your agent picks up where you left off.
          </p>
          <p className="text-ui text-muted-foreground">
            The brain is a file on this computer. Your conversations go to the model you sign in to, as in any
            Claude Code session.
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
          Both names also become fixed handles in your brain (who wrote what). How they're shown can be
          changed later.
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
