// v0.17 task runs (task cockpit-task-runs): start a session from a task that
// advances it stage by stage, stopping at a checkpoint after each stage (skill
// task-run). The run is a worker pane (addWorkerPane) on the desk the user
// picks; its first message names the task. The host ledger records the task id,
// so a running run shows here and a task has at most one run.
import { useMemo, useState } from "react";
import { Play, SquareTerminal } from "lucide-react";
import { useWritable } from "@/stores/useTeamStore";
import { useActiveSpace } from "@/stores/useSpaceStore";
import { startTaskSession } from "@/lib/task-board";
import { tellStartProblem } from "@/components/command-palette/openTask";

import { BrainCard } from "@/components/brain/ui";
import type { Engram } from "@/lib/types";
import type { Project, ProjectSession } from "@/types/app";
import {
  addWorkerPane,
  ensureDeskBySlug,
  getDesks,
  isEmptyPane,
  openInPane,
  removePane,
  useActiveDeskId,
  useDesks,
} from "@/stores/usePaneStore";
import { cn } from "@/lib/utils";
import { BUTTON, FIELD, LABEL, PRIMARY } from "@/shared/view/ui";

const NEW_DESK = "__new__";

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className={cn(LABEL, "mb-2")}>{children}</div>;
}

/** The run session of a task, across all projects. */
function findRun(projects: Project[], taskId: string): { project: Project; session: ProjectSession } | null {
  for (const project of projects) {
    const session = project.sessions?.find((s) => s.taskId === taskId);
    if (session) return { project, session };
  }
  return null;
}

/** The project a task belongs to: its scope project.<id> as a brain project. */
function projectOfTask(projects: Project[], engram: Engram): Project | undefined {
  const brainId = engram.scope.startsWith("project.") ? engram.scope.slice("project.".length) : null;
  return brainId ? projects.find((p) => p.brainProjectId === brainId) : undefined;
}

export function runPrompt(engram: Engram, extra: string): string {
  const name = engram.title ? `${engram.title} (id ${engram.id})` : `id ${engram.id}`;
  const line = extra.trim();
  return `Use the task-run skill for task ${name}.${line ? `\n\n${line}` : ""}`;
}

/** The desk choice that starts the run without a pane: it runs on the host, unattended. */
const NO_DESK = "__no-desk__";

export function TaskRunCard({ engram, projects, onStarted, background = false }: {
  engram: Engram;
  projects: Project[];
  onStarted?: () => void;
  /** Start without a desk by default (the Tasks view, where the run's chat shows next to the task). */
  background?: boolean;
}) {
  const desks = useDesks();
  const activeDeskId = useActiveDeskId();
  const run = useMemo(() => findRun(projects, engram.id), [projects, engram.id]);
  const defaultProject = useMemo(() => projectOfTask(projects, engram), [projects, engram]);

  const [open, setOpen] = useState(false);
  // A shared brain that is not live takes no write; a run would write (useTeamStore).
  const brain = useWritable();
  const activeSpace = useActiveSpace();
  const [deskId, setDeskId] = useState<string>(background ? NO_DESK : activeDeskId);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string>(defaultProject?.projectId ?? "");
  const [extra, setExtra] = useState("");

  if (engram.status !== "planned" && engram.status !== "active") return null;

  if (run) {
    return (
      <BrainCard className="px-4 py-3">
        <CardTitle>Task run</CardTitle>
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 text-ui text-muted-foreground">
            Runs in session <span className="text-foreground">{run.session.summary || run.session.id.slice(0, 8)}</span>
            {" · "}
            {run.project.displayName}
          </span>
          <button
            type="button"
            onClick={() => {
              openInPane({ surface: "terminal", projectId: run.project.projectId, sessionId: run.session.id });
              onStarted?.();
            }}
            className={cn(BUTTON, "shrink-0 gap-1.5 px-3 text-ui")}
          >
            <SquareTerminal aria-hidden className="size-3.5" />
            Open run
          </button>
        </div>
      </BrainCard>
    );
  }

  const start = () => {
    if (!projectId) return;
    const title = engram.title ?? "Task run";
    if (deskId === NO_DESK) {
      // Runs on the host; the request goes to the active space (the Tasks view switched to the task's).
      setError(null);
      void fetch("/api/tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, prompt: runPrompt(engram, extra), title, taskId: engram.id }),
      }).then(async (res) => {
        // A task with a session starting, or one whose session cannot take the run, is refused with the host's reason.
        if (!res.ok) {
          const body = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          setError(body?.error?.message ?? `The run could not start (HTTP ${res.status}).`);
          return;
        }
        setOpen(false);
        setExtra("");
        if (!background) onStarted?.();
      }).catch(() => setError("The run could not start: the cockpit did not answer."));
      return;
    }
    let target = deskId;
    let emptyPaneId: string | null = null;
    if (deskId === NEW_DESK) {
      // A desk of its own, created without taking focus; its empty starter
      // pane makes way for the run.
      target = ensureDeskBySlug(`task-${title}`, { name: title });
      const desk = getDesks().find((s) => s.id === target);
      if (desk && desk.panes.length === 1 && isEmptyPane(desk.panes[0])) emptyPaneId = desk.panes[0].id;
    }
    // The host starts it with the task bound (in chat when that is the user's view); an older host can't, so
    // then the pane starts it in the terminal.
    const prompt = runPrompt(engram, extra);
    // In a new desk the starter pane makes way only for a pane opened here; the host's pane arrives a moment later
    // next to it, and removing the desk's only pane first would leave no desk to open it on.
    const fallback = () => {
      addWorkerPane({ fromSessionId: null, projectId, prompt, title, deskId: target, taskId: engram.id });
      if (emptyPaneId) removePane(emptyPaneId);
    };
    if (activeSpace) void startTaskSession({ id: engram.id, spaceId: activeSpace.id }, { projectId, prompt, title, deskId: target }).then((outcome) => {
      if (outcome.kind === 'no_route') fallback();
      else tellStartProblem(outcome, title);
    });
    else fallback();
    setOpen(false);
    setExtra("");
    onStarted?.();
  };

  return (
    <BrainCard className="px-4 py-3">
      <CardTitle>Task run</CardTitle>
      {!open ? (
        // the button sits right of the description, so the card stays two lines high
        <div className="flex items-center justify-between gap-3">
          <span className="min-w-0 flex-1 text-ui text-muted-foreground">
            A session advances this task stage by stage and stops at a checkpoint after each.
          </span>
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={!brain.writable}
            title={brain.reason ?? undefined}
            className={cn(PRIMARY, "shrink-0 gap-1.5 px-3 text-ui")}
          >
            <Play aria-hidden className="size-3.5" />
            Advance task
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">
            Desk
            <select
              value={deskId}
              onChange={(e) => setDeskId(e.target.value)}
              className={cn(FIELD, "text-ui")}
            >
              {desks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id === activeDeskId ? " (current)" : ""}
                </option>
              ))}
              <option value={NEW_DESK}>New desk for this task</option>
              <option value={NO_DESK}>No desk: run in the background</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">
            Project
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className={cn(FIELD, "text-ui")}
            >
              {!projectId && <option value="">Choose a project…</option>}
              {projects.map((p) => (
                <option key={p.projectId} value={p.projectId}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">
            First message
            <div className="rounded-lg border border-border bg-muted px-3 py-1.5 font-code text-caption whitespace-pre-wrap text-foreground">
              {runPrompt(engram, "")}
            </div>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="Optional: add a line for the run"
              rows={2}
              className={cn(FIELD, "text-ui")}
            />
          </label>
          {deskId === NO_DESK && (
            <p className="text-caption text-muted-foreground">
              It runs without a pane and stops at each checkpoint with a question in Your turn. Its chat shows next to the task in the Tasks view.
            </p>
          )}
          {error && <p role="alert" className="text-caption text-stopped-ink">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className={cn(BUTTON, "px-3 text-ui")}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={start}
              disabled={!projectId}
              className={cn(PRIMARY, "gap-1.5 px-3 text-ui")}
            >
              <Play aria-hidden className="size-3.5" />
              Start run
            </button>
          </div>
        </div>
      )}
    </BrainCard>
  );
}
