// Restart the session: a new process for the same conversation, which loads its MCP
// servers, settings and skills fresh. During a turn it asks once, since the turn stops.
import { useEffect, useState } from 'react';
import { RotateCcw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { FOCUS } from '@/shared/view/ui';
import Tooltip from '@/shared/view/ui/Tooltip';

const CONFIRM_MS = 4_000;

export const RESTART_HINT = 'Restart session: loads MCP servers, settings and skills fresh';

/** What a click does now: restart at once, or first ask because a turn would stop. */
export function restartStep(running: boolean, confirming: boolean): 'restart' | 'confirm' {
  return running && !confirming ? 'confirm' : 'restart';
}

export function RestartButton({ running, onRestart }: { running: boolean; onRestart: () => void }) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  // The turn ended while it asked: nothing left to confirm.
  useEffect(() => { if (!running) setConfirming(false); }, [running]);

  const click = () => {
    if (restartStep(running, confirming) === 'confirm') { setConfirming(true); return; }
    setConfirming(false);
    onRestart();
  };

  if (confirming) {
    return (
      <button
        type="button"
        onClick={click}
        className={cn('justify-self-end rounded border border-border px-1.5 text-caption hover:bg-muted', FOCUS)}
      >
        Stop turn and restart
      </button>
    );
  }
  return (
    <Tooltip content={RESTART_HINT} position="top">
      <button
        type="button"
        aria-label="Restart session"
        onClick={click}
        className={cn('flex size-5 items-center justify-center justify-self-end rounded text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)}
      >
        <RotateCcw aria-hidden className="size-3" strokeWidth={1.8} />
      </button>
    </Tooltip>
  );
}
