// "Work on it today" (Tasks view): the project's desk with today's project lead
// (host domain/project-lead.ts). The host says which session leads the project
// today, or the id and first message of a new one; the desk is the project's
// own (made once, reused), and the lead's pane is put there or found again.
import { SPACE_HEADER } from '@/lib/space-header';
import {
  activateDesk, activatePane, addWorkerPane, ensureDeskBySlug, getActiveSpaceId, getDesks, isEmptyPane,
} from '@/stores/usePaneStore';
import { paneSpaceKey, switchSpace, type SpaceInfo } from '@/stores/useSpaceStore';
import { setTopView } from '@/stores/useTopViewStore';

type Lead = { sessionId: string; existing: boolean; title: string; prompt?: string };

/** The cockpit's id of a brain project (host project-registry.ts BRAIN_ID_PREFIX). */
export const projectIdOfBrain = (brainId: string) => `bp-${brainId}`;

export async function openProjectLead(space: SpaceInfo, projectId: string, name: string): Promise<string | null> {
  if (paneSpaceKey(space) !== getActiveSpaceId()) switchSpace(space);
  const res = await fetch('/api/projects/lead', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [SPACE_HEADER]: space.id },
    body: JSON.stringify({ projectId }),
  }).catch(() => null);
  if (!res) return 'The cockpit did not answer.';
  const body = await res.json().catch(() => ({})) as Lead & { error?: { message?: string } };
  if (!res.ok) return body.error?.message ?? `HTTP ${res.status}`;

  const deskId = ensureDeskBySlug(`project-${projectId}`, { name, defaultProjectId: projectId });
  const desk = getDesks().find((d) => d.id === deskId);
  const holding = desk?.panes.find((pane) => pane.sessionId === body.sessionId);
  if (holding) {
    activateDesk(deskId);
    activatePane(holding.id);
    setTopView('desks');
    return null;
  }
  // A new desk comes with an empty starter pane: the lead takes its place.
  const starter = desk && desk.panes.length === 1 && isEmptyPane(desk.panes[0]) ? desk.panes[0].id : null;
  addWorkerPane({
    fromSessionId: null, projectId, title: body.title, deskId, sessionId: body.sessionId,
    // Today's lead that runs already only joins; a new one starts with its brief.
    prompt: body.existing ? '' : body.prompt ?? '', replacePaneId: starter,
  });
  activateDesk(deskId);
  setTopView('desks');
  return null;
}
