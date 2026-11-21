import { useMemo, useState, type ReactNode } from 'react';
import { History } from 'lucide-react';

import { cn } from '@/lib/utils';
import { useNotes, useUnseenNotes } from '@/lib/notes';
import { FOCUS } from '@/shared/view/ui';
import type { Project } from '@/types/app';
import type { SidebarController } from '../../useSidebarController';
import { useRowMenu } from '../rowMenuContext';
import { isSessionRecent, readShowOlderIds, storeShowOlder } from '../../utils';
import { SidebarProjectActions } from './SidebarProjectActions';
import { useViewEnabled } from '@/lib/pane-views';
import { NewPaneButton, SidebarGroupLabel, SidebarProjectNotes, isRecentNote } from './SidebarProjectNotes';
import { SidebarSessionRow } from './SidebarSessionRow';

const SKELETON_WIDTHS = ['w-3/5', 'w-3/4', 'w-9/10'];

function SessionsSkeleton() {
  return (
    <>
      {SKELETON_WIDTHS.map((width) => (
        <div key={width} className="rounded-md p-2">
          <div className="flex items-start gap-2">
            <div className="mt-0.5 size-3 animate-pulse rounded-full bg-muted" />
            <div className="flex-1 space-y-1">
              <div className={cn('h-3 animate-pulse rounded bg-muted', width)} />
              <div className="h-2 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        </div>
      ))}
    </>
  );
}

export function SidebarSessionsArea({ project, controller }: { project: Project; controller: SidebarController }) {
  const menu = useRowMenu();
  const {
    now,
    selectedSessionId,
    openSessionIds,
    openNoteIds,
    listArrived,
    sessionRename,
  } = controller;

  const [showOlder, setShowOlder] = useState(() => readShowOlderIds().includes(project.projectId));
  const toggleShowOlder = () => {
    const next = !showOlder;
    setShowOlder(next);
    storeShowOlder(project.projectId, next);
  };

  // Notes switched off (Settings › EML Plugins): the project lists none.
  const notesOn = useViewEnabled()('note');
  const notesQuery = useNotes(project.projectId, notesOn && Boolean(project.brainProjectId));
  const notes = useMemo(() => (notesOn ? notesQuery.data ?? [] : []), [notesOn, notesQuery.data]);
  const unseenNotes = useUnseenNotes();

  const sessions = controller.sessionsOf(project);
  const nowMs = now.getTime();

  const olderSessionIds = useMemo(
    () =>
      new Set(
        sessions
          .filter((session) => !isSessionRecent(session, openSessionIds, selectedSessionId, nowMs))
          .map((session) => session.id),
      ),
    [sessions, openSessionIds, selectedSessionId, nowMs],
  );
  const olderNoteIds = useMemo(
    () => new Set(notes.filter((note) => !isRecentNote(note, openNoteIds, unseenNotes, nowMs)).map((note) => note.id)),
    [notes, openNoteIds, unseenNotes, nowMs],
  );
  const olderCount = olderSessionIds.size + olderNoteIds.size;
  // The "Sessions" label only separates the sessions from a notes group below.
  const notesShown = showOlder ? notes.length > 0 : notes.some((note) => !olderNoteIds.has(note.id));
  const shownSessions = showOlder ? sessions : sessions.filter((session) => !olderSessionIds.has(session.id));

  let body: ReactNode;
  if (!listArrived) {
    body = <SessionsSkeleton />;
  } else if (sessions.length === 0) {
    body = <div className="px-2 py-1 text-left text-ui text-muted-foreground">No sessions yet</div>;
  } else if (shownSessions.length === 0) {
    body = <div className="px-2 py-1 text-left text-ui text-muted-foreground">No recent sessions</div>;
  } else {
    body = shownSessions.map((session) => (
      <div key={session.id}>
        <SidebarSessionRow
          older={olderSessionIds.has(session.id)}
          session={session}
          projectId={project.projectId}
          isSelected={session.id === selectedSessionId}
          now={now}
          renameDraft={sessionRename?.id === session.id ? sessionRename.draft : null}
          onRenameDraftChange={controller.setSessionRenameDraft}
          onStartRename={controller.startSessionRename}
          onSaveRename={() => void controller.saveSessionRename()}
          onCancelRename={controller.cancelSessionRename}
          onSelect={controller.selectSession}
          onRequestDelete={controller.requestSessionDelete}
        />
      </div>
    ));
  }

  return (
    <div className="mt-0.5 ml-3 space-y-0.5 border-l border-border pl-2">
      <div className="flex items-center gap-0.5">
        <NewPaneButton project={project} onNewSession={controller.onNewSession} />
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {olderCount > 0 && (
            <button
              type="button"
              aria-pressed={showOlder}
              title={
                showOlder
                  ? 'Hide older sessions and notes'
                  : `Show ${olderCount} older ${olderCount === 1 ? 'item' : 'items'}`
              }
              onClick={(event) => {
                event.stopPropagation();
                toggleShowOlder();
              }}
              className={cn(
                'flex min-h-(--target-min) items-center gap-1 rounded-md px-1.5 transition-colors duration-(--duration-fast)',
                showOlder ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                FOCUS,
              )}
            >
              <History aria-hidden className="size-3" strokeWidth={showOlder ? 2.5 : 2} />
              <span className="text-caption tabular-nums">{olderCount}</span>
            </button>
          )}
          {!menu && (
            <SidebarProjectActions
              project={project}
              onToggleStar={(target) => void controller.toggleProjectStar(target)}
              onStartRename={controller.startProjectRename}
              onSetFolder={controller.onSetFolder}
              onToggleHidden={(target) => void controller.toggleProjectHidden(target)}
              onRequestRemove={controller.requestProjectDelete}
            />
          )}
        </div>
      </div>
      {notesShown && <SidebarGroupLabel>Sessions</SidebarGroupLabel>}
      {body}
      <SidebarProjectNotes
        project={project}
        notes={notes}
        oldNoteIds={olderNoteIds}
        showOld={showOlder}
        currentTime={now}
      />
    </div>
  );
}
