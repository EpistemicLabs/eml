// Settings › Preferences › Sessions: how much the sessions of this cockpit may
// hold (host limits.json, session-limits.ts). Unlike the rows around them they
// live on the host, not in this browser: they hold for every device.
import { useEffect, useState } from 'react';

import SettingsRow from '../SettingsRow';

type Limits = { memoryGb: number; idleHours: number; maxRunning: number };
type Answer = { limits: Limits; ceilingUnavailable: string | null };

const MEMORY = [0, 1, 1.5, 2, 3, 4, 6, 8];
const IDLE = [0.25, 0.5, 1, 2, 4, 8, 24];
const RUNNING = [0, 4, 6, 8, 10, 12, 16, 20];

const inlineSelectClass =
  'rounded-md border border-foreground/8 bg-transparent p-2 text-sm text-foreground focus:border-foreground/40 focus:outline-none';

const memoryLabel = (gb: number) => (gb === 0 ? 'No ceiling' : `${gb} GB`);
const idleLabel = (hours: number) => (hours < 1 ? `${hours * 60} min` : `${hours} h`);
const runningLabel = (n: number) => (n === 0 ? 'No cap' : String(n));

// A value set outside these lists still shows as itself.
const withValue = (options: number[], value: number) => (options.includes(value) ? options : [...options, value].sort((a, b) => a - b));

export default function SessionLimitsRows() {
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch('/api/limits')
      .then(async (res) => { if (live && res.ok) setAnswer(await res.json() as Answer); })
      .catch(() => { /* rows stay hidden */ });
    return () => { live = false; };
  }, []);

  const change = async (patch: Partial<Limits>) => {
    setProblem(null);
    const res = await fetch('/api/limits', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => null);
    if (res?.ok) { setAnswer(await res.json() as Answer); return; }
    const body = await res?.json().catch(() => null) as { error?: { message?: string } } | null;
    setProblem(body?.error?.message ?? 'Could not save that');
  };

  if (!answer) return null;
  const { limits, ceilingUnavailable } = answer;
  const select = (label: string, value: number, options: number[], text: (n: number) => string, key: keyof Limits) => (
    <select
      value={value}
      onChange={(event) => void change({ [key]: Number(event.target.value) })}
      className={`${inlineSelectClass} w-36`}
      aria-label={label}
    >
      {withValue(options, value).map((n) => <option key={n} value={n}>{text(n)}</option>)}
    </select>
  );

  return (
    <>
      <SettingsRow
        label="Memory per session"
        description={`A process of a session that goes past this is stopped alone, and the session says so; the rest of the machine keeps running. Applies from the session's next start.${ceilingUnavailable ? ` Not active here: ${ceilingUnavailable}.` : ''}`}
      >
        {select('Memory per session', limits.memoryGb, MEMORY, memoryLabel, 'memoryGb')}
      </SettingsRow>
      <SettingsRow
        label="Stop quiet sessions after"
        description="A session nobody is looking at frees its memory after this long without activity; one with a window open after 2 hours at the least, one waiting on a card after 4. Never mid-turn. A message or opening it resumes it."
      >
        {select('Stop quiet sessions after', limits.idleHours, IDLE, idleLabel, 'idleHours')}
      </SettingsRow>
      <SettingsRow
        label="Sessions running at once"
        description="At the cap, the session quiet longest stops to make room; when all are busy, new workers wait. A session you open yourself never waits."
      >
        {select('Sessions running at once', limits.maxRunning, RUNNING, runningLabel, 'maxRunning')}
      </SettingsRow>
      {problem && <div role="alert" className="px-4 pb-3 text-sm text-destructive">{problem}</div>}
    </>
  );
}
