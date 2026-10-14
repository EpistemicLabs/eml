import type { ReactNode } from "react";
import { takeOverWindow, useWindowState } from "@/lib/single-window";

/**
 * Renders the cockpit only in the active window (lib/single-window.ts). An
 * inactive window mounts nothing — no terminals, no polling — and offers to
 * take over.
 */
export function SingleWindowGate({ children }: { children: ReactNode }) {
  const state = useWindowState();
  if (state === "checking") return null;
  if (state === "elsewhere") return <OpenElsewhere />;
  return <>{children}</>;
}

function OpenElsewhere() {
  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-5 rounded-lg border border-border bg-card p-6">
        <div className="space-y-1.5">
          <h1 className="text-heading font-semibold">Open in another window</h1>
          <p className="text-ui text-muted-foreground">
            The cockpit runs in one window at a time, so your sessions don't jump between windows. Use it here
            and the other window pauses.
          </p>
        </div>
        <button
          type="button"
          onClick={takeOverWindow}
          autoFocus
          className="w-full rounded-md bg-primary px-3 py-2 text-body font-medium text-primary-foreground"
        >
          Use here
        </button>
      </div>
    </div>
  );
}
