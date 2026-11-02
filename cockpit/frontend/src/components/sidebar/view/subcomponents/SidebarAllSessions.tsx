import { useMemo, useState } from 'react';
import { ChevronRight, MessageSquare } from 'lucide-react';

import { startReview } from '@/lib/review-flow';
import { answerSession, archiveSession, clearSession, markSessionRead, setAnswering, stopSession, useAnswering } from '@/lib/session-actions';
import { cn } from '@/lib/utils';
import { useActiveSpaceId } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces, type SpaceInfo } from '@/stores/useSpaceStore';
import { useTurnStore } from '@/stores/useTurnStateStore';
import {
  agentLabel, agentLetter, allSessionState, countsLine, filterByName, groupAllSessions, sessionMark, type AllSession, type MainItem,
} from '../../allSessions';
import type { SidebarController } from '../../useSidebarController';
import { sessionDisplayName } from '../../utils';
import { SidebarGroupHeader, SidebarStateBlock } from './SidebarParts';
import { SidebarSessionRow } from './SidebarSessionRow';

const RECENT_PER_AGENT = 5;
const SHOW_MORE_STEP = 20;

function ReplyBox({ session, controller }: { session: AllSession; controller: SidebarController }) {
  const [draft, setDraft] = useState('');
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setAnswering(null);
    void answerSession(session.id, text).then((error) => { if (error) controller.reportError(error); });
  };
  return (
    <div className="flex gap-1 px-2 pt-0.5 pb-1">
      <input
        autoFocus
        type="text"
        value={draft}
        enterKeyHint="send"
        aria-label={`Answer ${sessionDisplayName(session)}`}
        placeholder="Your answer"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter') send();
          else if (event.key === 'Escape') setAnswering(null);
        }}
        className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1 text-base text-foreground outline-none select-text focus:border-primary md:text-xs"
      />
      <button type="button" onClick={send} disabled={!draft.trim()} className="rounded-md border border-border px-2 text-xs text-foreground hover:bg-accent disabled:opacity-40">
        Send
      </button>
    </div>
  );
}

function AllSessionRow({ session, spaces, controller, sessions, detail, leading, nested, plain }: {
  session: AllSession;
  spaces: SpaceInfo[];
  controller: SidebarController;
  /** Every session, to name a worker's parent. */
  sessions: AllSession[];
  detail?: string;
  leading?: React.ReactNode;
  nested?: boolean;
  /** No mark: a row under its parent, or found by search. */
  plain?: boolean;
}) {
  const { sessionRename } = controller;
  const { turns } = useTurnStore();
  const answering = useAnswering();
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
          if (session.attention) void markSessionRead(session.id);
        }}
        onRequestDelete={controller.requestSessionDelete}
        pin={{
          isPinned: pinned,
          onToggle: (target) => void controller.toggleSessionPin(target),
        }}
        agent={{ letter: agentLetter(space), name: agentLabel(space) }}
        mark={mark}
        detail={detail}
        context={parent ? sessionDisplayName(parent) : undefined}
        leading={leading}
        nested={nested}
        actions={{
          onAnswer: session.attention?.kind === 'question' ? () => setAnswering(session.id) : undefined,
          onStop: running && working ? () => void stopSession(session.id).then(whenDone) : undefined,
          onClear: session.attention && pinned ? () => void clearSession(session.id).then(whenDone) : undefined,
          onArchive: !session.archivedAt && !working ? () => void archiveSession(session.id).then(whenDone) : undefined,
        }}
      />
      {answering === session.id && <ReplyBox session={session} controller={controller} />}
    </div>
  );
}

function MainRow({ item, spaces, controller, sessions }: { item: MainItem; spaces: SpaceInfo[]; controller: SidebarController; sessions: AllSession[] }) {
  const [open, setOpen] = useState(false);
  const { session, workers, counts } = item;
  const line = countsLine(counts);
  const expandable = workers.length > 0;
  return (
    <div className="space-y-0.5">
      <AllSessionRow
        session={session}
        spaces={spaces}
        controller={controller}
        sessions={sessions}
        plain
        detail={line || undefined}
        leading={expandable ? (
          <span
            role="button"
            tabIndex={0}
            aria-label={open ? 'Hide workers' : 'Show workers'}
            aria-expanded={open}
            className="-ml-1 flex h-5 w-4 flex-shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
            onClick={(event) => { event.stopPropagation(); setOpen(!open); }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return;
              event.preventDefault();
              event.stopPropagation();
              setOpen(!open);
            }}
          >
            <ChevronRight className={cn('transition-transform', open && 'rotate-90')} />
          </span>
        ) : undefined}
      />
      {open && workers.map((worker) => (
        <AllSessionRow key={worker.id} session={worker} spaces={spaces} controller={controller} sessions={sessions} nested />
      ))}
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

function useSections(controller: SidebarController) {
  const spaces = useSpaces();
  const { turns } = useTurnStore();
  const { allSessions, queuedWorkers, isSessionPinned, now } = controller;
  const sections = useMemo(
    () => groupAllSessions(allSessions ?? [], spaces, turns, isSessionPinned, now.getTime(), queuedWorkers),
    [allSessions, spaces, turns, isSessionPinned, now, queuedWorkers],
  );
  return { sections, spaces, sessions: allSessions ?? [] };
}

/** What needs the user and what is finished: on top of every view. */
export function SidebarInbox({ controller, onlyOpenSpace = false }: { controller: SidebarController; onlyOpenSpace?: boolean }) {
  const { sections, spaces, sessions } = useSections(controller);
  const openSpace = useActiveSpaceId();
  const here = (session: AllSession) => {
    if (!onlyOpenSpace) return true;
    const space = spaces.find((candidate) => candidate.id === session.spaceId);
    return space ? paneSpaceKey(space) === openSpace : false;
  };
  const needsYou = sections.needsYou.filter(here);
  const toReview = sections.toReview.filter(here);
  const row = (session: AllSession) => (
    <AllSessionRow key={session.id} session={session} spaces={spaces} controller={controller} sessions={sessions} />
  );
  const waiting = needsYou.length + toReview.length;
  if (waiting === 0) return null;
  return (
    <div className={cn('space-y-3', onlyOpenSpace && 'pb-3')}>
      <div className="px-2">
        <button
          type="button"
          onClick={() => startReview([...needsYou, ...toReview], spaces)}
          className="w-full rounded-md border border-border px-2 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
        >
          Review {waiting} ▶
        </button>
      </div>
      {needsYou.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Needs you · {needsYou.length}</SidebarGroupHeader>
          {needsYou.map(row)}
        </div>
      )}
      {toReview.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>To review · {toReview.length}</SidebarGroupHeader>
          {toReview.map(row)}
        </div>
      )}
    </div>
  );
}

export function SidebarAllSessions({ controller }: { controller: SidebarController }) {
  const { sections, spaces, sessions } = useSections(controller);
  const [query, setQuery] = useState('');
  const [extra, setExtra] = useState<Record<string, number>>({});
  const { allSessions } = controller;

  if (allSessions === null) return <SidebarStateBlock spinner text="Loading sessions…" />;
  if (allSessions.length === 0) return <SidebarStateBlock icon={MessageSquare} text="No sessions yet" />;

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
      <SidebarInbox controller={controller} />
      {sections.main.length > 0 && (
        <div className="space-y-0.5">
          <SidebarGroupHeader>Main sessions</SidebarGroupHeader>
          {sections.main.map((group) => (
            <div key={group.space.id} className="space-y-0.5">
              <AgentName space={group.space} />
              {group.items.map((item) => (
                <MainRow key={item.session.id} item={item} spaces={spaces} controller={controller} sessions={sessions} />
              ))}
            </div>
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
