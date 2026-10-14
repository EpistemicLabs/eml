import type { ReactNode } from 'react';

import type { ShellOverlay as ShellOverlayState } from '../../hooks/useShellRuntime';

const TITLE_LIMIT = 50;

interface ShellOverlayProps {
  state: ShellOverlayState;
  sessionTitle: string | null;
  onConnect: () => void;
}

function BoltIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-4 shrink-0"
    >
      <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
    </svg>
  );
}

function connectCopy(superseded: boolean, sessionTitle: string | null) {
  const title = sessionTitle ? sessionTitle.slice(0, TITLE_LIMIT) : null;
  if (superseded) {
    return {
      label: 'Take over here',
      tooltip: 'Reconnect this terminal here (the other tab is disconnected)',
      description: title
        ? `"${title}" is open in another tab or window. Take it over to continue here.`
        : 'This terminal is open in another tab or window. Take it over to continue here.',
    };
  }
  return {
    label: 'Connect',
    tooltip: 'Connect to the session',
    description: title ? `Resume "${title}" in an isolated session` : 'Start an isolated session',
  };
}

export default function ShellOverlay({ state, sessionTitle, onConnect }: ShellOverlayProps) {
  let content: ReactNode;

  switch (state.kind) {
    case 'loading':
      content = <p className="text-sm text-foreground">Loading terminal…</p>;
      break;
    case 'error':
      content = <p className="max-w-sm text-center text-xs text-muted-foreground">{state.message}</p>;
      break;
    case 'connecting':
      content = (
        <div className="flex flex-col items-center gap-1 text-center">
          <div className="flex items-center gap-2 text-sm font-medium text-foreground">
            <span
              aria-hidden="true"
              className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
            Connecting…
          </div>
          <p className="text-xs text-muted-foreground">Starting session…</p>
        </div>
      );
      break;
    case 'connect': {
      const copy = connectCopy(state.superseded, sessionTitle);
      content = (
        <div className="flex w-full max-w-sm flex-col items-center gap-2 text-center">
          <button
            type="button"
            title={copy.tooltip}
            onClick={onConnect}
            className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 active:bg-primary/80 sm:w-auto"
          >
            <BoltIcon />
            {copy.label}
          </button>
          <p className="text-xs text-muted-foreground">{copy.description}</p>
        </div>
      );
      break;
    }
  }

  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/90 p-4">{content}</div>
  );
}
