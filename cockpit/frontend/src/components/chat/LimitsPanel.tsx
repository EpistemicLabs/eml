// A session's limits: the tools it may not use and the MCP servers it is held to, set by the
// job or session that started it. The user can lift them here with a restart; no agent can.
import { useState } from 'react';
import { Lock, X } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button, FOCUS } from '@/shared/view/ui';
import Tooltip from '@/shared/view/ui/Tooltip';

import type { SessionLimits } from './chat-store';

/** The chip's text, or null when the session has no limits. */
export function limitsLabel(limits: SessionLimits | null): string | null {
  if (!limits) return null;
  const tools = limits.deniedTools.length;
  if (tools === 0 && limits.mcpServers === null) return null;
  if (tools === 0) return 'MCP limited';
  return `${tools} ${tools === 1 ? 'tool' : 'tools'} blocked`;
}

export function LimitsChip({ limits, open, onToggle }: { limits: SessionLimits | null; open: boolean; onToggle: () => void }) {
  const label = limitsLabel(limits);
  if (!label) return null;
  return (
    <Tooltip content="What this session may not use" position="top">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className={cn('flex items-center gap-1 justify-self-end rounded px-1 text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)}
      >
        <Lock aria-hidden className="size-3" strokeWidth={1.8} />
        <span>{label}</span>
      </button>
    </Tooltip>
  );
}

export function LimitsPanel({ limits, running, onLift, onClose }: {
  limits: SessionLimits;
  running: boolean;
  onLift: (forJob: boolean) => void;
  onClose: () => void;
}) {
  // On by default: a job that blocked a tool would block it again on its next run.
  const [forJob, setForJob] = useState(true);
  const { job } = limits;
  return (
    <div className="rounded-xl border border-border bg-card p-2 text-ui">
      <div className="flex items-center justify-between pb-1">
        <span className="font-semibold">Limits of this session</span>
        <Tooltip content="Close limits" position="top">
          <button type="button" aria-label="Close limits" onClick={onClose} className={cn('flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)}>
            <X aria-hidden className="size-3.5" />
          </button>
        </Tooltip>
      </div>
      {/* Plain text: tool, server and job names come from configuration. */}
      <p className="text-muted-foreground">{job ? `Set by the job "${job.name}".` : 'Set when the session started.'}</p>
      {limits.deniedTools.length > 0 && (
        <div className="pt-1">
          <div className="text-muted-foreground">Blocked tools</div>
          <ul className="font-code text-caption">
            {limits.deniedTools.map((tool) => <li key={tool} className="break-all">{tool}</li>)}
          </ul>
        </div>
      )}
      {limits.mcpServers !== null && (
        <div className="pt-1">
          <div className="text-muted-foreground">Only these MCP servers, besides the brain</div>
          <div className="font-code text-caption break-all">{limits.mcpServers.length ? limits.mcpServers.join(', ') : 'none'}</div>
        </div>
      )}
      {limits.liftable ? (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
          {job ? (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" className="accent-foreground" checked={forJob} onChange={(e) => setForJob(e.target.checked)} />
              <span>Also for future runs of this job</span>
            </label>
          ) : <span />}
          <Button size="sm" variant="outline" onClick={() => onLift(job ? forJob : false)}>
            {running ? 'Stop turn and restart without limits' : 'Restart without limits'}
          </Button>
        </div>
      ) : (
        <p className="pt-2 text-muted-foreground">This job answers messages from outside. Lend it tools in the Jobs view.</p>
      )}
    </div>
  );
}
