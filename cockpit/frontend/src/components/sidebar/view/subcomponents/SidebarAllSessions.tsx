import { useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';

import { paneSpaceKey, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import { agentLabel, agentLetter, filterByName, groupAllSessions, type AllSession } from '../../allSessions';
import type { SidebarController } from '../../useSidebarController';
import { SidebarGroupHeader, SidebarStateBlock } from './SidebarParts';
import { SidebarSessionRow } from './SidebarSessionRow';

const RECENT_PER_AGENT = 5;
const SHOW_MORE_STEP = 20;

function AllSessionRow({ session, spaces, controller }: { session: AllSession; spaces: SpaceInfo[]; controller: SidebarController }) {
  const { sessionRename } = controller;
  const space = spaces.find((candidate) => candidate.id === session.spaceId) ?? spaces[0];
  return (
    <div className="px-px">
      <SidebarSessionRow
        session={session}
        projectId={session.__projectId ?? ''}
        isSelected={session.id === controller.selectedSessionId}
        now={controller.now}
        renameDraft={sessionRename?.id === session.id ? sessionRename.draft : null}
        onRenameDraftChange={controller.setSessionRenameDraft}
        onStartRename={controller.startSessionRename}
        onSaveRename={() => void controller.saveSessionRename()}
        onCancelRename={controller.cancelSessionRename}
        onSelect={(picked, projectId) => controller.selectSession({ ...picked, __spaceKey: paneSpaceKey(space) }, projectId)}
        onRequestDelete={controller.requestSessionDelete}
        pin={{
          isPinned: controller.isSessionPinned(session),
          onToggle: (target) => void controller.toggleSessionPin(target),
        }}
        agent={{ letter: agentLetter(space), name: agentLabel(space) }}
      />
    </div>
  );
}

function AgentName({ space }: { space: SpaceInfo }) {
  return (
    <div className="truncate px-2 pt-1 text-[11px] font-medium text-muted-foreground" title={space.name}>
      {agentLabel(space)}
    </div>
  );
}

export function SidebarAllSessions({ controller }: { controller: SidebarController }) {
  const spaces = useSpaces();
  const { turns } = useTurnStore();
  const [query, setQuery] = useState('');
  const [extra, setExtra] = useState<Record<string, number>>({});
  const { allSessions, isSessionPinned } = controller;

  const sections = useMemo(
    () => groupAllSessions(allSessions ?? [], spaces, turns, isSessionPinned),
    [allSessions, spaces, turns, isSessionPinned],
  );

  if (allSessions === null) return <SidebarStateBlock spinner text="Loading sessions…" />;
  if (allSessions.length === 0) return <SidebarStateBlock icon={MessageSquare} text="No sessions yet" />;

  const row = (session: AllSession) => (
    <AllSessionRow key={session.id} session={session} spaces={spaces} controller={controller} />
  );
  const searching = query.trim() !== '';
  const recent = sections.recent
    .map((group) => ({ ...group, matching: filterByName(group.sessions, query) }))
    .filter((group) => group.matching.length > 0);

  return (
    <div className="space-y-3">
      {sections.waiting.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Waiting</SidebarGroupHeader>
          {sections.waiting.map(row)}
        </div>
      )}
      {sections.pinned.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Pinned</SidebarGroupHeader>
          {sections.pinned.map((group) => (
            <div key={group.space.id} className="space-y-0.5">
              <AgentName space={group.space} />
              {group.sessions.map(row)}
            </div>
          ))}
        </div>
      )}
      {sections.working.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Working</SidebarGroupHeader>
          {sections.working.map(row)}
        </div>
      )}
      {sections.recent.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Recent</SidebarGroupHeader>
          <div className="px-2 pb-1">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search sessions"
              aria-label="Search recent sessions"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          {recent.map((group) => {
            const limit = searching ? group.matching.length : RECENT_PER_AGENT + (extra[group.space.id] ?? 0);
            const hidden = group.matching.length - limit;
            return (
              <div key={group.space.id} className="space-y-0.5">
                <AgentName space={group.space} />
                {group.matching.slice(0, limit).map(row)}
                {hidden > 0 && (
                  <button
                    type="button"
                    onClick={() => setExtra((current) => ({ ...current, [group.space.id]: (current[group.space.id] ?? 0) + SHOW_MORE_STEP }))}
                    className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    Show {Math.min(hidden, SHOW_MORE_STEP)} more
                  </button>
                )}
              </div>
            );
          })}
          {searching && recent.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-muted-foreground">No matching sessions</p>
          )}
        </div>
      )}
    </div>
  );
}
