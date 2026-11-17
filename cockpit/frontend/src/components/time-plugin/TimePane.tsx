// The `time` pane view (task cockpit-plugin-time-tracking): the user's time at
// the cockpit, today and over the week, per project; under a project the
// sessions and tasks it went to, and next to it the time the agents ran (their
// own column: agents run side by side, so it is no part of the user's total).
// Data: GET /api/plugins/time (host time-tracking.ts), fed by useTimeBeat.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Bot, ChevronRight, ListTodo, Loader2, Terminal } from 'lucide-react';

import { BrainCard, SectionHeader } from '@/components/brain/ui';
import { useEngram } from '@/lib/queries';
import { cn } from '@/lib/utils';
import type { Project } from '@/types/app';

interface Split {
  user: number;
  agent: number;
}

interface DayTime {
  date: string;
  user: number;
  projects: Record<string, Split>;
  tasks: Record<string, Split & { projectId: string | null }>;
  sessions: Record<string, Split & { projectId: string | null; taskId: string | null }>;
}

interface TimeAnswer {
  days: DayTime[];
  sessions: Record<string, string | null>;
}

const DAYS = 7;

/** 0:42 → "42m", 3:05 → "3h 05m"; under a minute "<1m". */
export function formatSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return seconds > 0 ? '<1m' : '0m';
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** The days' figures added up into one. */
export function sumDays(days: DayTime[]): DayTime {
  const total: DayTime = { date: '', user: 0, projects: {}, tasks: {}, sessions: {} };
  const addTo = <T extends Split>(into: Record<string, T>, from: Record<string, T>) => {
    for (const [id, split] of Object.entries(from)) {
      const row = (into[id] ??= { ...split, user: 0, agent: 0 });
      row.user += split.user;
      row.agent += split.agent;
    }
  };
  for (const day of days) {
    total.user += day.user;
    addTo(total.projects, day.projects);
    addTo(total.tasks, day.tasks);
    addTo(total.sessions, day.sessions);
  }
  return total;
}

export function TimePane({ projects }: { projects: Project[] }) {
  const time = useQuery({
    queryKey: ['plugin-time', DAYS],
    queryFn: async (): Promise<TimeAnswer> => {
      const res = await fetch(`/api/plugins/time?days=${DAYS}`);
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
      return body as TimeAnswer;
    },
    refetchInterval: 30_000,
  });
  const [range, setRange] = useState<'today' | 'week'>('today');

  if (!time.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {time.error ? time.error.message : <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
    );
  }
  const { days, sessions: sessionNames } = time.data;
  const shown = range === 'today' ? days[days.length - 1] : sumDays(days);
  const projectName = (id: string) =>
    id ? projects.find((p) => p.projectId === id)?.displayName ?? id : 'No project';
  const agentTotal = Object.values(shown.projects).reduce((sum, p) => sum + p.agent, 0);
  const rows = Object.entries(shown.projects).sort(([, a], [, b]) => b.user - a.user || b.agent - a.agent);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-3">
        <BrainCard className="p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs text-muted-foreground">{range === 'today' ? 'Today at the cockpit' : `Last ${DAYS} days at the cockpit`}</div>
              <div className="mt-1 text-3xl font-semibold tabular-nums">{formatSeconds(shown.user)}</div>
              <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <Bot className="h-3.5 w-3.5" /> Agents ran {formatSeconds(agentTotal)}
              </div>
            </div>
            <div className="flex rounded-md bg-foreground/10 p-0.5 text-xs">
              {(['today', 'week'] as const).map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setRange(value)}
                  className={cn('rounded px-2 py-1', range === value ? 'bg-foreground/20 text-foreground' : 'text-muted-foreground hover:text-foreground')}
                >
                  {value === 'today' ? 'Today' : `${DAYS} days`}
                </button>
              ))}
            </div>
          </div>
          {range === 'week' && <WeekBars days={days} />}
        </BrainCard>

        <BrainCard className="p-3">
          <SectionHeader
            title="Projects"
            right={<span className="flex gap-4 text-[11px] text-muted-foreground"><span className="w-16 text-right">You</span><span className="w-16 text-right">Agents</span></span>}
            className="mb-1.5"
          />
          {rows.length === 0 && <div className="px-1 py-2 text-sm text-muted-foreground">Nothing counted yet. The clock runs while you work in the cockpit.</div>}
          {rows.map(([id, split]) => (
            <ProjectRow key={id || 'none'} name={projectName(id)} split={split} day={shown} projectId={id || null} sessionNames={sessionNames} />
          ))}
        </BrainCard>
      </div>
    </div>
  );
}

function WeekBars({ days }: { days: DayTime[] }) {
  const max = Math.max(...days.map((d) => d.user), 1);
  return (
    <div className="mt-4 flex h-24 items-end gap-2">
      {days.map((day) => (
        <div key={day.date} className="flex flex-1 flex-col items-center gap-1" title={`${day.date}: ${formatSeconds(day.user)}`}>
          <div className="flex w-full flex-1 items-end">
            <div className="w-full rounded-sm bg-primary/70" style={{ height: `${(day.user / max) * 100}%`, minHeight: day.user > 0 ? 2 : 0 }} />
          </div>
          <div className="text-[10px] text-muted-foreground">
            {new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' })}
          </div>
        </div>
      ))}
    </div>
  );
}

function Figures({ split }: { split: Split }) {
  return (
    <span className="flex shrink-0 gap-4 text-sm tabular-nums">
      <span className="w-16 text-right">{formatSeconds(split.user)}</span>
      <span className="w-16 text-right text-muted-foreground">{formatSeconds(split.agent)}</span>
    </span>
  );
}

function ProjectRow({ name, split, day, projectId, sessionNames }: {
  name: string;
  split: Split;
  day: DayTime;
  projectId: string | null;
  sessionNames: Record<string, string | null>;
}) {
  const [open, setOpen] = useState(false);
  const byTime = <T extends Split>(rows: Array<[string, T]>) => rows.sort(([, a], [, b]) => b.user + b.agent - (a.user + a.agent));
  const tasks = byTime(Object.entries(day.tasks).filter(([, t]) => t.projectId === projectId));
  const sessions = byTime(Object.entries(day.sessions).filter(([, s]) => s.projectId === projectId));
  const hasDetail = tasks.length > 0 || sessions.length > 0;
  return (
    <div>
      <button
        type="button"
        disabled={!hasDetail}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded px-1 py-1.5 text-left hover:bg-foreground/5 disabled:hover:bg-transparent"
      >
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90', !hasDetail && 'invisible')} />
        <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
        <Figures split={split} />
      </button>
      {open && (
        <div className="mb-1 ml-6 space-y-0.5">
          {tasks.map(([id, task]) => <TaskRow key={id} id={id} split={task} />)}
          {sessions.map(([id, session]) => (
            <DetailRow key={id} icon={Terminal} label={sessionNames[id] ?? 'Session'} split={session} />
          ))}
        </div>
      )}
    </div>
  );
}

function TaskRow({ id, split }: { id: string; split: Split }) {
  const task = useEngram(id);
  return <DetailRow icon={ListTodo} label={task.data?.title ?? 'Task'} split={split} />;
}

function DetailRow({ icon: Icon, label, split }: { icon: typeof Terminal; label: string; split: Split }) {
  return (
    <div className="flex items-center gap-2 px-1 py-1 text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-sm">{label}</span>
      <Figures split={split} />
    </div>
  );
}
