// The sidebar's All view: the sessions of every brain space sorted into its
// sections. Pure, so the rules (no session twice, a pinned one coming back
// after it waited) are tested without a browser.
import type { SpaceInfo } from '@/stores/useSpaceStore';
import type { TurnInfo, TurnState } from '@/stores/useTurnStateStore';
import type { ProjectSession } from '@/types/app';

/** A session as GET /api/sessions/all returns it. */
export type AllSession = ProjectSession & { spaceId: string };

export interface AgentGroup {
  space: SpaceInfo;
  sessions: AllSession[];
}

export interface AllSections {
  waiting: AllSession[];
  pinned: AgentGroup[];
  working: AllSession[];
  recent: AgentGroup[];
}

const NO_SESSIONS: AgentGroup[] = [];

/** What a space's sessions are labelled with: its agent, else the space's name (host spaceLabel). */
export const agentLabel = (space: SpaceInfo): string => space.label ?? space.name;

export const agentLetter = (space: SpaceInfo): string => agentLabel(space).charAt(0).toUpperCase();

/**
 * The turn state to show. The host keeps a session's last state after its
 * process ended, so an ended session counts as idle here.
 */
export function allSessionState(session: ProjectSession, turn: TurnInfo | undefined): TurnState {
  if (session.state === 'ended') return 'idle';
  return turn?.state ?? session.turnState ?? 'idle';
}

const activityOf = (session: ProjectSession) => session.lastActivity ?? session.createdAt ?? '';
const newestFirst = (a: ProjectSession, b: ProjectSession) => activityOf(b).localeCompare(activityOf(a));
// Oldest first and not by activity: a pinned row keeps its place while its session works.
const stableOrder = (a: AllSession, b: AllSession) =>
  (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id);

/** Each session in exactly one section; spaces keep the order of the space list. */
export function groupAllSessions(
  sessions: AllSession[],
  spaces: SpaceInfo[],
  turns: Record<string, TurnInfo>,
  isPinned: (session: ProjectSession) => boolean,
): AllSections {
  if (spaces.length === 0) return { waiting: [], pinned: NO_SESSIONS, working: [], recent: NO_SESSIONS };
  const waiting: AllSession[] = [];
  const pinned: AllSession[] = [];
  const working: AllSession[] = [];
  const recent: AllSession[] = [];
  for (const session of sessions) {
    const state = allSessionState(session, turns[session.id]);
    if (state === 'waiting') waiting.push(session);
    else if (isPinned(session)) pinned.push(session);
    else if (state === 'working') working.push(session);
    else recent.push(session);
  }
  const byAgent = (list: AllSession[], order: (a: AllSession, b: AllSession) => number): AgentGroup[] =>
    spaces
      .map((space) => ({ space, sessions: list.filter((session) => session.spaceId === space.id).sort(order) }))
      .filter((group) => group.sessions.length > 0);
  return {
    waiting: waiting.sort(newestFirst),
    pinned: byAgent(pinned, stableOrder),
    working: working.sort(newestFirst),
    recent: byAgent(recent, newestFirst),
  };
}

/** The sessions whose name holds `query` (any case); all of them when it is blank. */
export function filterByName(sessions: AllSession[], query: string): AllSession[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return sessions;
  return sessions.filter((session) => (session.summary ?? '').toLowerCase().includes(wanted));
}
