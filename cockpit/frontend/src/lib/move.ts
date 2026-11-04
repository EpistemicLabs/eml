// Moving a project into a shared space, as the UI drives it (host:
// project-move.ts, GET /api/projects/:id/move-plan and POST …/move; spec
// team-brain-move-project-spec §5, decision move-project-deterministic-ui):
// the target chooser over the cockpit's shared spaces, the plan the host
// answers for one target, the run the user confirms with the plan's hash, and
// how each answer reads. The reasons a move is refused are the server's texts
// shown as they are; the sentences here are the only wording of the UI's own.
// No DOM in this module, so it is unit-tested as it is.
import { errorText, hostCall, stateTitle, writable, type HostAnswer, type Team } from './team';
import type { SpaceInfo } from '@/stores/useSpaceStore';

/** The plan the host answers (core ProjectMovePlan, with the server's own refusal first in collisions). */
export interface MovePlanView {
  project: string;
  source: string;
  target: string;
  plan_hash: string;
  /** The project and its sub-projects, parents first, each with the engrams it holds. */
  tree: Array<{ id: string; engrams: number }>;
  moved: { engrams: number; entries: number; relations: number };
  /** The links to things that stay behind: dropped in the source, kept in the backup. */
  crossing: Array<{ id: string; relation: string; direction: 'out' | 'in'; other: { id: string; type: string; title: string | null } }>;
  payload_bytes: number;
  /** Why the move is refused, in the server's words; empty: it goes. */
  collisions: string[];
}

/** What a move that went through answers (core ProjectMoveResult plus the host's re-homed projects). */
export interface MoveDoneView {
  project: string;
  archived: string[];
  rehomed: string[];
  backup_path: string;
  resumed: boolean;
}

const projectPath = (projectId: string, rest = '') => `/api/projects/${encodeURIComponent(projectId)}${rest}`;

export const fetchMovePlan = (projectId: string, targetId: string): Promise<HostAnswer<MovePlanView>> =>
  hostCall<MovePlanView>(projectPath(projectId, `/move-plan?target=${encodeURIComponent(targetId)}`), { cache: 'no-store' });

export const runMove = (projectId: string, targetId: string, planHash: string): Promise<HostAnswer<MoveDoneView>> =>
  hostCall<MoveDoneView>(projectPath(projectId, '/move'), { method: 'POST', body: JSON.stringify({ target: targetId, plan_hash: planHash }) });

/** One op into a shared brain carries at most this much (protocol MAX_PAYLOAD); the plan's size line names it. */
export const MOVE_LIMIT_BYTES = 16 * 1024 * 1024;

/** Bytes as the size line says them: whole KB under a megabyte, else MB with one decimal; the limit as a whole number. */
const size = (bytes: number): string => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** A target the chooser offers: a shared space of this cockpit, chosen only while it takes writes. */
export interface MoveTargetOption {
  id: string;
  name: string;
  /** The space's name, with its state after a dash while it cannot be chosen. */
  label: string;
  enabled: boolean;
}

/**
 * The shared spaces as the chooser lists them. A space whose team the host has
 * not reported yet counts as open: the plan carries the server's refusal if not.
 */
export function targetOptions(spaces: SpaceInfo[], teams: Record<string, Team>): MoveTargetOption[] {
  return spaces
    .filter((s) => s.shared)
    .map((s) => {
      const team = teams[s.id];
      const enabled = writable(true, team).writable;
      const state = team?.shared ? stateTitle(team) : null;
      return { id: s.id, name: s.name, label: enabled || !state ? s.name : `${s.name} — ${state}`, enabled };
    });
}

/** Whether the move button shows at all: a local space with a shared space to move into. */
export const canOfferMove = (active: SpaceInfo | null, spaces: SpaceInfo[]): boolean =>
  active !== null && !active.shared && spaces.some((s) => s.shared);

/** The plan as the dialog says it, one sentence per line. */
export interface PlanText {
  what: string;
  /** The tree by name with its engrams, when the project has sub-projects; null otherwise. */
  projects: Array<{ id: string; name: string; engrams: number }> | null;
  dropped: string;
  /** The dropped links as "<title> (<type>)". */
  links: string[];
  size: string;
}

export function planText(plan: MovePlanView, projectName: string, nameOf: (id: string) => string): PlanText {
  const parts = `${count(plan.moved.engrams, 'engram')}, ${count(plan.moved.entries, 'journal entry', 'journal entries')} and ${count(plan.moved.relations, 'link')} between them`;
  const withChildren = plan.tree.length > 1;
  const what = withChildren
    ? `This moves ${projectName} with its sub-projects: ${parts}, in ${count(plan.tree.length, 'project')}.`
    : `This moves ${projectName}: ${parts}.`;
  const c = plan.crossing.length;
  return {
    what,
    projects: withChildren ? plan.tree.map((t) => ({ id: t.id, name: nameOf(t.id), engrams: t.engrams })) : null,
    dropped: c === 0 ? 'Nothing links out of this project.' : `${count(c, 'link')} to things that stay behind ${c === 1 ? 'is' : 'are'} dropped. ${c === 1 ? 'It is' : 'They are'} kept in the backup.`,
    links: plan.crossing.map((r) => `${r.other.title ?? r.other.id} (${r.other.type})`),
    size: `Size: ${size(plan.payload_bytes)} of ${MOVE_LIMIT_BYTES / 1024 / 1024} MB.`,
  };
}

/** What the run's answer means for the dialog. */
export type MoveOutcome =
  | { kind: 'done'; text: string; backup: string }
  | { kind: 'changed'; text: string }
  | { kind: 'pending'; text: string }
  | { kind: 'failed'; text: string };

export function moveOutcome(answer: HostAnswer<Partial<MoveDoneView> & { code?: string; error?: unknown }>, projectName: string, spaceName: string): MoveOutcome {
  const { status, body } = answer;
  if (status === 200) {
    return { kind: 'done', text: `Moved. ${projectName} is now in ${spaceName}; the copy here is archived and points there.`, backup: typeof body.backup_path === 'string' ? body.backup_path : '' };
  }
  if (status === 409 && body.code === 'PLAN_CHANGED') {
    return { kind: 'changed', text: 'The project changed since this plan was made. Here is the current one.' };
  }
  if (status === 504 && body.code === 'SHARED_WRITE_PENDING') {
    return { kind: 'pending', text: `The move was sent, but ${spaceName} did not confirm it in time. Nothing was removed here. Once ${spaceName} is connected again, Move picks up where it stopped.` };
  }
  // read-only (503), refused (409), unreachable (502) and the rest: the server's or the host's own sentence
  return { kind: 'failed', text: errorText(body, `The move failed (${status}).`) };
}

/** Where an archived project went, when a move archived it (core writes moved_to / moved_at / moved_to_name). */
export interface MovedMarker {
  to: string;
  name: string | null;
  at: string;
}

export function movedMarker(metadata: Record<string, unknown> | null | undefined): MovedMarker | null {
  if (!metadata || typeof metadata.moved_to !== 'string' || typeof metadata.moved_at !== 'string') return null;
  return { to: metadata.moved_to, at: metadata.moved_at, name: typeof metadata.moved_to_name === 'string' ? metadata.moved_to_name : null };
}
