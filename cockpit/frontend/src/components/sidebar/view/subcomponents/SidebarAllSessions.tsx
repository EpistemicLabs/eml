import { useEffect, useMemo, useState } from 'react';
import { MessageSquare } from 'lucide-react';

import { spaceTone } from '@/lib/space-color';
import { joinReview, startReview } from '@/lib/review-flow';
import { archiveSession, clearSession, markSessionRead, stopSession } from '@/lib/session-actions';
import { useActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import {
  agentLabel, allSessionState, filterByName, groupAllSessions, isUnseen, sessionMark, type AllSections, type AllSession,
} from '../../allSessions';
import type { SidebarController } from '../../useSidebarController';
import { sessionDisplayName } from '../../utils';
import { SidebarGroupHeader, SidebarStateBlock } from './SidebarParts';
import { SidebarSessionRow } from './SidebarSessionRow';

const RECENT_PER_AGENT = 5;
const SHOW_MORE_STEP = 20;

/** One session, on its own row: a worker's says where it comes from. */
function AllSessionRow({ session, spaces, controller, sessions, plain }: {
  session: AllSession;
  spaces: SpaceInfo[];
  controller: SidebarController;
  /** Every session, to name a worker's parent. */
  sessions: AllSession[];
  /** No mark: a row outside what needs the user. */
  plain?: boolean;
}) {
  const { sessionRename } = controller;
  const { turns } = useTurnStore();
  const space = spaces.find((candidate) => candidate.id === session.spaceId) ?? spaces[0];
  const mark = plain ? null : sessionMark(session, turns[session.id]);
  const parent = session.parentSessionId ? sessions.find((candidate) => candidate.id === session.parentSessionId) : undefined;
  const pinned = controller.isSessionPinned(session);
  const running = session.state === 'running' || session.state === 'detached';
  const working = allSessionState(session, turns[session.id]) === 'working';
  const whenDone = (error: string | null) => { if (error) controller.reportError(error); };
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
        onSelect={(picked, projectId) => {
          controller.selectSession({ ...picked, __spaceKey: paneSpaceKey(space) }, projectId);
          if (isUnseen(session)) void markSessionRead(session.id);
        }}
        onRequestDelete={controller.requestSessionDelete}
        pin={{
          isPinned: pinned,
          onToggle: (target) => void controller.toggleSessionPin(target),
        }}
        agent={{ name: agentLabel(space), tone: spaceTone(space) }}
        mark={mark}
        context={parent ? `from ${sessionDisplayName(parent)}` : undefined}
        actions={{
          onStop: running && working ? () => void stopSession(session.id).then(whenDone) : undefined,
          onClear: session.attention?.kind === 'review' || (session.attention && pinned) ? () => void clearSession(session.id).then(whenDone) : undefined,
          onArchive: !session.archivedAt && !working ? () => void archiveSession(session.id).then(whenDone) : undefined,
        }}
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

/** The sections over every space, or, with onlyOpenSpace, over the open one. */
function useSections(controller: SidebarController, onlyOpenSpace: boolean) {
  const allSpaces = useSpaces();
  const openSpace = useActiveSpaceId();
  const { turns } = useTurnStore();
  const { allSessions, queuedWorkers, isSessionPinned, now } = controller;
  const spaces = useMemo(
    () => (onlyOpenSpace ? allSpaces.filter((space) => paneSpaceKey(space) === openSpace) : allSpaces),
    [allSpaces, onlyOpenSpace, openSpace],
  );
  const sessions = useMemo(() => {
    if (!onlyOpenSpace) return allSessions ?? [];
    const shown = new Set(spaces.map((space) => space.id));
    return (allSessions ?? []).filter((session) => shown.has(session.spaceId));
  }, [allSessions, onlyOpenSpace, spaces]);
  const sections = useMemo(
    () => groupAllSessions(sessions, spaces, turns, isSessionPinned, now.getTime(), queuedWorkers),
    [sessions, spaces, turns, isSessionPinned, now, queuedWorkers],
  );
  return { sections, spaces, sessions };
}

/** What waits for the user, what needs an answer first: the review's queue, in its order. */
function useWaiting(sections: AllSections): AllSession[] {
  return useMemo(() => [...sections.needsYou, ...sections.toReview], [sections]);
}

/**
 * How many wait for the user: what the overview's tab says while another view is
 * open. The sidebar is always there, so what newly waits joins an open review from here.
 */
export function useWaitingCount(controller: SidebarController, onlyOpenSpace: boolean): number {
  const { sections } = useSections(controller, onlyOpenSpace);
  const waiting = useWaiting(sections);
  useEffect(() => joinReview(waiting), [waiting]);
  return waiting.length;
}

/** A heading of the inbox; the last one carries the way into the review, which goes through all of it. */
function InboxHeader({ title, onReview }: { title: string; onReview?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-1 pr-2">
      <SidebarGroupHeader>{title}</SidebarGroupHeader>
      {onReview && (
        <button
          type="button"
          onClick={onReview}
          className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/10"
        >
          Review ▶
        </button>
      )}
    </div>
  );
}

/** What needs the user and what is finished: on top of the overview. */
function SidebarInbox({ controller, onlyOpenSpace }: { controller: SidebarController; onlyOpenSpace: boolean }) {
  const { sections, spaces, sessions } = useSections(controller, onlyOpenSpace);
  const { needsYou, toReview } = sections;
  const waiting = useWaiting(sections);
  const row = (session: AllSession) => (
    <AllSessionRow key={session.id} session={session} spaces={spaces} controller={controller} sessions={sessions} />
  );
  if (waiting.length === 0) return null;
  const review = () => startReview(waiting);
  return (
    <div className="space-y-3">
      {needsYou.length > 0 && (
        <div className="space-y-0.5">
          <InboxHeader title={`Needs you · ${needsYou.length}`} onReview={toReview.length === 0 ? review : undefined} />
          {needsYou.map(row)}
        </div>
      )}
      {toReview.length > 0 && (
        <div className="space-y-0.5">
          <InboxHeader title={`To review · ${toReview.length}`} onReview={review} />
          {toReview.map(row)}
        </div>
      )}
    </div>
  );
}

/** The overview (beta): of every space under All spaces, else of the open one. */
export function SidebarAllSessions({ controller, onlyOpenSpace }: { controller: SidebarController; onlyOpenSpace: boolean }) {
  const { sections, spaces, sessions } = useSections(controller, onlyOpenSpace);
  const [query, setQuery] = useState('');
  const [extra, setExtra] = useState<Record<string, number>>({});
  if (controller.allSessions === null) return <SidebarStateBlock spinner text="Loading sessions…" />;
  if (sessions.length === 0) return <SidebarStateBlock icon={MessageSquare} text="No sessions yet" />;

  const row = (session: AllSession) => (
    <AllSessionRow key={session.id} session={session} spaces={spaces} controller={controller} sessions={sessions} plain />
  );
  const searching = query.trim() !== '';
  const recent = sections.recent
    .map((group) => ({ ...group, matching: filterByName(group.sessions, query) }))
    .filter((group) => group.matching.length > 0);
  const found = searching ? filterByName(sections.searchOnly, query) : [];

  return (
    <div className="space-y-3">
      <SidebarInbox controller={controller} onlyOpenSpace={onlyOpenSpace} />
      {sections.main.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Main sessions</SidebarGroupHeader>
          {sections.main.map((group) => (
            <div key={group.space.id} className="space-y-0.5">
              <AgentName space={group.space} />
              {group.items.map((item) => (
                <AllSessionRow key={item.session.id} session={item.session} spaces={spaces} controller={controller} sessions={sessions} plain />
              ))}
            </div>
          ))}
        </div>
      )}
      {sections.working.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Working · {sections.working.length}</SidebarGroupHeader>
          {sections.working.map((item) => (
            <AllSessionRow key={item.session.id} session={item.session} spaces={spaces} controller={controller} sessions={sessions} plain />
          ))}
        </div>
      )}
      <div className="space-y-0.5">
        <SidebarGroupHeader>Recent</SidebarGroupHeader>
        <div className="px-2 pb-1">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="w-full rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none select-text focus:border-primary md:text-xs"
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
        {found.map(row)}
        {searching && recent.length === 0 && found.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">No matching sessions</p>
        )}
      </div>
    </div>
  );
}
