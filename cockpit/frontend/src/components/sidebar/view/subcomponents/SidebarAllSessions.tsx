import { useEffect, useMemo, useState } from 'react';
import { MessageSquare, Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { joinReview, startReview } from '@/lib/review-flow';
import { archiveSession, clearSession, markSessionRead, stopSession } from '@/lib/session-actions';
import { useActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import {
  agentLabel, agentLetter, allSessionState, filterByName, groupAllSessions, isUnseen, newestFirst, sessionMark, type AllSections, type AllSession,
} from '../../allSessions';
import type { SidebarController } from '../../useSidebarController';
import { sessionDisplayName } from '../../utils';
import { SidebarGroupHeader, SidebarStateBlock } from './SidebarParts';
import { SidebarSessionRow } from './SidebarSessionRow';

const RECENT_SHOWN = 10;
const SHOW_MORE_STEP = 20;

/** One session, on its own row: a worker's says where it comes from. */
function AllSessionRow({ session, spaces, controller, sessions, plain, listedRunning }: {
  session: AllSession;
  spaces: SpaceInfo[];
  controller: SidebarController;
  /** Every session, to name a worker's parent. */
  sessions: AllSession[];
  /** No mark: a row outside what needs the user. */
  plain?: boolean;
  /** Listed because it runs now. */
  listedRunning?: boolean;
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
        agent={{ name: agentLabel(space), letter: agentLetter(space) }}
        mark={mark}
        running={Boolean(listedRunning)}
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

/** What is going on right now, as one card on top of the overview: what needs the user, what is finished, what runs. */
function SidebarNow({ controller, onlyOpenSpace }: { controller: SidebarController; onlyOpenSpace: boolean }) {
  const { sections, spaces, sessions } = useSections(controller, onlyOpenSpace);
  const { needsYou, toReview, working } = sections;
  const waiting = useWaiting(sections);
  const row = (session: AllSession, listedRunning = false) => (
    <AllSessionRow key={session.id} session={session} spaces={spaces} controller={controller} sessions={sessions} plain={listedRunning} listedRunning={listedRunning} />
  );
  if (waiting.length === 0 && working.length === 0) return null;
  return (
    // The scroll region's padding is uneven; the margins line the card up with the tabs above.
    <div className="-mr-1 ml-0.5 space-y-2 rounded-lg bg-foreground/[0.04] py-1.5 ring-1 ring-foreground/[0.07]">
      <div className="flex items-center justify-between gap-1 pr-2 pl-2">
        <span className="text-xs font-semibold text-foreground">Now</span>
        {waiting.length > 0 && (
          <button
            type="button"
            onClick={() => startReview(waiting)}
            className="flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-foreground transition-colors hover:bg-foreground/10"
          >
            Review {waiting.length} ▶
          </button>
        )}
      </div>
      {needsYou.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Needs you</SidebarGroupHeader>
          {needsYou.map((session) => row(session))}
        </div>
      )}
      {toReview.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>To review</SidebarGroupHeader>
          {toReview.map((session) => row(session))}
        </div>
      )}
      {working.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Working</SidebarGroupHeader>
          {working.map((item) => row(item.session, true))}
        </div>
      )}
    </div>
  );
}

/** The overview (beta): of every space under All spaces, else of the open one. */
export function SidebarAllSessions({ controller, onlyOpenSpace }: { controller: SidebarController; onlyOpenSpace: boolean }) {
  const { sections, spaces, sessions } = useSections(controller, onlyOpenSpace);
  const [query, setQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [extra, setExtra] = useState(0);
  if (controller.allSessions === null) return <SidebarStateBlock spinner text="Loading sessions…" />;
  if (sessions.length === 0) return <SidebarStateBlock icon={MessageSquare} text="No sessions yet" />;

  const row = (session: AllSession) => (
    <AllSessionRow key={session.id} session={session} spaces={spaces} controller={controller} sessions={sessions} plain />
  );
  const searching = query.trim() !== '';
  // One list by time; the icon on each row says whose it is.
  const recent = filterByName(sections.recent.flatMap((group) => group.sessions), query).sort(newestFirst);
  const limit = searching ? recent.length : RECENT_SHOWN + extra;
  const hidden = recent.length - limit;
  const found = searching ? filterByName(sections.searchOnly, query) : [];
  const closeSearch = () => { setSearchOpen(false); setQuery(''); };

  return (
    <div className="space-y-3">
      <SidebarNow controller={controller} onlyOpenSpace={onlyOpenSpace} />
      {sections.main.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Pinned sessions</SidebarGroupHeader>
          {sections.main.flatMap((group) => group.items).map((item) => row(item.session))}
        </div>
      )}
      <div className="space-y-0.5">
        <div className="flex items-center justify-between gap-1 pr-1">
          <SidebarGroupHeader>Recent sessions</SidebarGroupHeader>
          <button
            type="button"
            aria-label="Search sessions"
            aria-expanded={searchOpen}
            title="Search sessions"
            onClick={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            className={cn(
              'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors hover:bg-accent hover:text-foreground',
              searchOpen ? 'text-foreground' : 'text-muted-foreground',
            )}
          >
            <Search className="h-3.5 w-3.5" />
          </button>
        </div>
        {searchOpen && (
          <div className="px-2 pb-1">
            <input
              autoFocus
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Escape') closeSearch(); }}
              placeholder="Search sessions"
              aria-label="Search sessions"
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none select-text focus:border-primary md:text-xs"
            />
          </div>
        )}
        {recent.slice(0, limit).map(row)}
        {hidden > 0 && (
          <button
            type="button"
            onClick={() => setExtra((current) => current + SHOW_MORE_STEP)}
            className="w-full rounded-md px-2 py-1 text-left text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
          >
            Show {Math.min(hidden, SHOW_MORE_STEP)} more
          </button>
        )}
        {found.map(row)}
        {searching && recent.length === 0 && found.length === 0 && (
          <p className="px-2 py-1 text-[11px] text-muted-foreground">No matching sessions</p>
        )}
      </div>
    </div>
  );
}
