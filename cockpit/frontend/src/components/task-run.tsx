// v0.17 task runs (task cockpit-task-runs): start a session from a task that
// advances it stage by stage, stopping at a checkpoint after each stage (skill
// task-run). The run is a worker pane (addWorkerPane) on the desk the user
// picks; its first message names the task. The host ledger records the task id,
// so a running run shows here and a task has at most one run.
import { useMemo, useState } from "react";
import { Play, SquareTerminal } from "lucide-react";

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

const NEW_DESK = "__new__";

function CardTitle({ children }: { children: React.ReactNode }) {
  return <div className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground uppercase">{children}</div>;
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

export function TaskRunCard({ engram, projects, onStarted }: { engram: Engram; projects: Project[]; onStarted?: () => void }) {
  const desks = useDesks();
  const activeDeskId = useActiveDeskId();
  const run = useMemo(() => findRun(projects, engram.id), [projects, engram.id]);
  const defaultProject = useMemo(() => projectOfTask(projects, engram), [projects, engram]);

  const [open, setOpen] = useState(false);
  const [deskId, setDeskId] = useState<string>(activeDeskId);
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
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-ui text-foreground transition-colors hover:bg-accent/60"
          >
            <SquareTerminal className="h-3.5 w-3.5" />
            Open run
          </button>
        </div>
      </BrainCard>
    );
  }

  const start = () => {
    if (!projectId) return;
    const title = engram.title ?? "Task run";
    let target = deskId;
    let emptyPaneId: string | null = null;
    if (deskId === NEW_DESK) {
      // A desk of its own, created without taking focus; its empty starter
      // pane makes way for the run.
      target = ensureDeskBySlug(`task-${title}`, { name: title });
      const desk = getDesks().find((s) => s.id === target);
      if (desk && desk.panes.length === 1 && isEmptyPane(desk.panes[0])) emptyPaneId = desk.panes[0].id;
    }
    addWorkerPane({
      fromSessionId: null,
      projectId,
      prompt: runPrompt(engram, extra),
      title,
      deskId: target,
      taskId: engram.id,
    });
    if (emptyPaneId) removePane(emptyPaneId);
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
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-ui text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Play className="h-3.5 w-3.5" />
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
              className="rounded-md border border-border bg-background px-2 py-1 text-ui text-foreground"
            >
              {desks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                  {s.id === activeDeskId ? " (current)" : ""}
                </option>
              ))}
              <option value={NEW_DESK}>New desk for this task</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-caption text-muted-foreground">
            Project
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="rounded-md border border-border bg-background px-2 py-1 text-ui text-foreground"
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
            <div className="rounded-md border border-border bg-muted/40 px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-foreground">
              {runPrompt(engram, "")}
            </div>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="Optional: add a line for the run"
              rows={2}
              className="rounded-md border border-border bg-background px-2 py-1 text-ui text-foreground"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-border px-2.5 py-1 text-ui text-muted-foreground transition-colors hover:bg-accent/60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={start}
              disabled={!projectId}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-ui text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              Start run
            </button>
          </div>
        </div>
      )}
    </BrainCard>
  );
}
