// "Move to shared space…" on the project page of the Brain tab (spec
// team-brain-move-project-spec §5, block 4b): the one dialog of the move —
// a target chooser over the cockpit's shared spaces, the plan the host
// answers for that target, one confirm. No choices beyond the target: a
// project moves with its sub-projects, links to things that stay behind are
// dropped and listed, a backup is taken first (decision
// move-project-deterministic-ui). The reasons a move is refused are the
// server's words. The texts live in lib/move.ts with their tests.
import { useCallback, useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';

import { keys, useProjects } from '@/lib/queries';
import { fetchMovePlan, lostOutcome, moveOutcome, planText, runMove, targetOptions, type MoveOutcome, type MovePlanView } from '@/lib/move';
import { errorText } from '@/lib/team';
import { PROJECTS_CHANGED_EVENT } from '@/hooks/useProjectsState';
import { useSpaces } from '@/stores/useSpaceStore';
import { refreshTeams, useTeams } from '@/stores/useTeamStore';
import { Button, Dialog, DialogContent, DialogTitle } from '@/shared/view/ui';

type PlanState = { status: 'loading' } | { status: 'ready'; plan: MovePlanView } | { status: 'error'; text: string };
type RunState = { status: 'idle' } | { status: 'running' } | { status: 'answered'; outcome: MoveOutcome };

const selectClass = 'w-full rounded-md border border-border bg-transparent px-2 py-1.5 text-sm text-foreground focus:border-foreground/40 focus:outline-none disabled:opacity-50';

export default function MoveProjectDialog({ projectId, projectName, open, onOpenChange }: {
  projectId: string;
  projectName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const spaces = useSpaces();
  const teams = useTeams();
  const options = targetOptions(spaces, teams);
  const allProjects = useProjects();
  const qc = useQueryClient();
  const [targetId, setTargetId] = useState<string>('');
  const [plan, setPlan] = useState<PlanState>({ status: 'loading' });
  const [run, setRun] = useState<RunState>({ status: 'idle' });
  const target = options.find((o) => o.id === targetId) ?? null;
  const done = run.status === 'answered' && run.outcome.kind === 'done';
  const pending = run.status === 'answered' && run.outcome.kind === 'pending';
  const running = run.status === 'running';

  // The first space that takes writes is chosen when the dialog opens; the state starts over.
  useEffect(() => {
    if (!open) return;
    setTargetId((options.find((o) => o.enabled) ?? options[0])?.id ?? '');
    setRun({ status: 'idle' });
  }, [open]); // on open only: the options' identity changes with every poll

  const loadPlan = useCallback(async (space: string) => {
    setPlan({ status: 'loading' });
    let answer: Awaited<ReturnType<typeof fetchMovePlan>>;
    try {
      answer = await fetchMovePlan(projectId, space);
    } catch {
      setPlan({ status: 'error', text: 'Could not reach the cockpit to work out the move. Close this and try again.' });
      return;
    }
    if (answer.status !== 200 || typeof answer.body.plan_hash !== 'string') {
      setPlan({ status: 'error', text: errorText(answer.body, `Could not work out the move (${answer.status}).`) });
      return;
    }
    setPlan({ status: 'ready', plan: answer.body });
  }, [projectId]);

  useEffect(() => {
    if (!open || !targetId) return;
    void loadPlan(targetId);
  }, [open, targetId, loadPlan]);

  // the project is archived here and lives there: the Brain views and the sidebar read again
  const readAgain = () => {
    void qc.invalidateQueries({ queryKey: ['project'] });
    void qc.invalidateQueries({ queryKey: keys.projects() });
    window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
    void refreshTeams();
  };

  const move = async () => {
    if (plan.status !== 'ready' || !target) return;
    setRun({ status: 'running' });
    let outcome: MoveOutcome;
    try {
      outcome = moveOutcome(await runMove(projectId, target.id, plan.plan.plan_hash), projectName, target.name);
    } catch {
      // no answer at all: without this the dialog stayed on "Moving…" with Cancel disabled
      outcome = lostOutcome(projectName);
    }
    setRun({ status: 'answered', outcome });
    if (outcome.kind === 'changed') void loadPlan(target.id);
    if (outcome.kind === 'done' || outcome.kind === 'lost') readAgain();
  };

  const nameOf = (id: string) => allProjects.data?.projects.find((p) => p.id === id)?.name ?? id;
  const text = plan.status === 'ready' ? planText(plan.plan, projectName, nameOf) : null;
  const refused = plan.status === 'ready' ? plan.plan.collisions : [];
  // after a pending write the target has to be live again before the same plan is sent once more
  const targetWritable = target?.enabled ?? false;
  const canMove = plan.status === 'ready' && refused.length === 0 && targetWritable && !running && !done;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!running) onOpenChange(next); }}>
      <DialogContent className="max-w-lg rounded-lg border border-border bg-card shadow-xl" aria-busy={running}>
        <div className="border-b border-border p-4">
          <DialogTitle className="not-sr-only text-lg font-semibold text-foreground">Move {projectName} to a shared space</DialogTitle>
        </div>

        <div className="flex flex-col gap-4 p-4 text-sm">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">Shared space</span>
            <select className={selectClass} value={targetId} onChange={(e) => { setTargetId(e.target.value); setRun({ status: 'idle' }); }} disabled={running || done || pending}>
              {options.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.enabled}>{o.label}</option>
              ))}
            </select>
          </label>

          {plan.status === 'loading' && <p className="text-muted-foreground">Working out what moves…</p>}
          {plan.status === 'error' && <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground">{plan.text}</p>}
          {text && (
            <div className="flex flex-col gap-2 text-foreground">
              <p>{text.what}</p>
              {text.projects && (
                <ul className="ml-4 list-disc text-muted-foreground">
                  {text.projects.map((p) => <li key={p.id}>{p.name} · {p.engrams}</li>)}
                </ul>
              )}
              <p>{text.dropped}</p>
              {text.links.length > 0 && (
                <ul className="ml-4 max-h-40 list-disc overflow-y-auto text-muted-foreground">
                  {text.links.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              )}
              <p>{text.size}</p>
              <p className="text-muted-foreground">A backup of this space is taken before anything moves.</p>
            </div>
          )}

          {refused.length > 0 && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <p className="font-medium text-foreground">This project cannot move right now:</p>
              <ul className="ml-4 mt-1 list-disc text-muted-foreground">
                {refused.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </div>
          )}

          {run.status === 'answered' && (
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-foreground" role="status">
              <p>{run.outcome.text}</p>
              {run.outcome.kind === 'done' && run.outcome.backup && (
                <p className="mt-1 break-all font-mono text-xs text-muted-foreground">Backup: {run.outcome.backup}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border p-4">
          {done ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>Cancel</Button>
              <Button onClick={() => void move()} disabled={!canMove}>
                {running && <Loader2 className="animate-spin" />}
                {running ? 'Moving…' : 'Move'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
