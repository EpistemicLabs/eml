// A shared space's team as the host reports it (GET /api/spaces/:id/team, the
// brain server's view; spec team-brain-membership-flows-spec §5) and the
// calls the UI makes on it. The UI shows the state the server reports and
// reuses the server's read-only text verbatim; the titles here are the only
// wording of its own. No DOM in this module, so it is unit-tested as it is.

export type Role = 'owner' | 'member';

export type SyncState =
  | { kind: 'offline' }
  | { kind: 'catching_up' }
  | { kind: 'live' }
  | { kind: 'waiting_key'; epoch: number }
  | { kind: 'joining'; waiting: 'relay' | 'accept' | 'membership' | 'key' }
  | { kind: 'stopped'; why: string; relay?: { code: string; message: string } }
  | { kind: 'update_needed'; why: string };

export interface MemberView {
  id: string;
  fingerprint: string;
  handle: string | null;
  role: Role;
  devices: number;
  self: boolean;
}

export interface InviteView {
  invite_id: string;
  expires_at: string;
  role: Role;
  pending: { member: string; fingerprint: string; handle: string; received_at: string } | null;
}

/** GET /team of a shared brain; a private brain answers `{ shared: false }`. */
export interface TeamSnapshot {
  shared: true;
  brain: string;
  relay: string | null;
  mode: 'create' | 'join' | 'member' | null;
  state: SyncState;
  /** The 503 text a write gets right now; null while the brain is live. */
  read_only: string | null;
  member: MemberView | null;
  members: MemberView[];
  invites: InviteView[];
}

export type Team = TeamSnapshot | { shared: false };

/** The banner's and the space row's title for a state; null while live (no banner). */
export function stateTitle(team: TeamSnapshot): string | null {
  switch (team.state.kind) {
    case 'live': return null;
    case 'joining': return 'Joining the shared brain…';
    case 'offline': return 'Not connected to the relay';
    case 'catching_up': return 'Catching up with the relay…';
    case 'waiting_key': return 'Waiting for a brain key';
    case 'stopped': return team.mode === 'join' ? 'This join did not go through.' : 'This shared brain stopped';
    case 'update_needed': return 'Update the cockpit to use this shared brain';
  }
}

/** The step a join is at, as the banner's detail line. */
export function joinStep(state: SyncState): string | null {
  if (state.kind !== 'joining') return null;
  switch (state.waiting) {
    case 'relay': return 'Sending the join to the relay…';
    case 'accept': return 'Waiting for the owner to confirm your join.';
    case 'membership': return 'Confirmed — waiting for your membership to be recorded.';
    case 'key': return 'Receiving the brain key…';
  }
}

/** How the state is shown: amber while something is under way, red when it is broken. */
export function stateTone(state: SyncState): 'info' | 'destructive' {
  return state.kind === 'joining' || state.kind === 'catching_up' || state.kind === 'waiting_key' ? 'info' : 'destructive';
}

/** A join that stopped before the brain had anything: a new link or the space's removal are the way out. */
export const deadJoin = (team: TeamSnapshot): boolean => team.state.kind === 'stopped' && team.mode === 'join';

/**
 * Whether the UI may write to a space's brain: a local space always, a
 * shared one while the server reports it live (`read_only` null). The one
 * rule every write control reads; `reason` is the server's text for the
 * control's title.
 */
export function writable(shared: boolean | null, team: Team | undefined): { writable: boolean; reason: string | null } {
  if (!shared) return { writable: true, reason: null };
  if (!team || !team.shared) return { writable: true, reason: null };
  return team.read_only === null ? { writable: true, reason: null } : { writable: false, reason: team.read_only };
}

/** The host of a relay origin (wss://relay.example.com → relay.example.com), for the row text. */
export function relayHost(relay: string | null): string | null {
  if (!relay) return null;
  try { return new URL(relay).host; } catch { return relay; }
}

// --- the calls ---

/** What the host answered: the status and the body, as the server or the host wrote it. */
export interface HostAnswer<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/**
 * The error text of a host answer. The host's own routes answer
 * `{error: {code, message}}`; what it passes through from the brain server
 * answers `{error: string, code}`.
 */
export function errorText(body: unknown, fallback: string): string {
  if (body && typeof body === 'object') {
    const error = (body as { error?: unknown }).error;
    if (typeof error === 'string' && error) return error;
    if (error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') return (error as { message: string }).message;
  }
  return fallback;
}

async function call<T = Record<string, unknown>>(path: string, init?: RequestInit): Promise<HostAnswer<T>> {
  const res = await fetch(path, {
    ...init,
    headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  let body: unknown = {};
  if (text) { try { body = JSON.parse(text); } catch { body = { error: text }; } }
  return { status: res.status, body: (body && typeof body === 'object' ? body : {}) as T };
}

const spacePath = (spaceId: string, rest = '') => `/api/spaces/${encodeURIComponent(spaceId)}${rest}`;

export const fetchTeam = (spaceId: string): Promise<HostAnswer<Team>> => call<Team>(spacePath(spaceId, '/team'), { cache: 'no-store' });

export const createInvite = (spaceId: string, role: Role) =>
  call<{ invite_id?: string; link?: string; expires_at?: string }>(spacePath(spaceId, '/invites'), { method: 'POST', body: JSON.stringify({ role }) });

export const confirmJoin = (spaceId: string, inviteId: string) =>
  call(spacePath(spaceId, `/invites/${encodeURIComponent(inviteId)}/accept`), { method: 'POST', body: '{}' });

export const cancelInvite = (spaceId: string, inviteId: string) =>
  call(spacePath(spaceId, `/invites/${encodeURIComponent(inviteId)}/cancel`), { method: 'POST', body: '{}' });

export const removeSpace = (spaceId: string) => call(spacePath(spaceId), { method: 'DELETE' });
