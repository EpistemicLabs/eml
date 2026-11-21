import { useRef, type ReactNode } from 'react';
import { Archive, Check, Edit2, MoreHorizontal, Pin, Square, Trash2, X } from 'lucide-react';

import SessionProviderLogo from '@/components/llm-logo-provider/SessionProviderLogo';
import { useLongPress } from '@/hooks/useLongPress';
import { cn } from '@/lib/utils';
import { FIELD, FOCUS, ROW } from '@/shared/view/ui';
import { isUnseenDone, useTurnStore } from '@/stores/useTurnStateStore';
import type { ProjectSession } from '@/types/app';
import { MARK_SYMBOL, MARK_WORD, allSessionState, isRead, type SessionMark } from '../../allSessions';
import { compactAge, sessionDisplayName, sessionTimeString } from '../../utils';
import { useRowMenu } from '../rowMenuContext';
import { CHIP, CHIP_DELETE } from './SidebarParts';

export interface SessionRowProps {
  session: ProjectSession;
  projectId: string;
  isSelected: boolean;
  now: Date;
  /** The rename draft while this session is being renamed, else null. */
  renameDraft: string | null;
  onRenameDraftChange: (draft: string) => void;
  onStartRename: (session: ProjectSession) => void;
  onSaveRename: () => void;
  onCancelRename: () => void;
  onSelect: (session: ProjectSession, projectId: string) => void;
  onRequestDelete: (projectId: string, session: ProjectSession) => void;
  /** Given only where the row offers the pin chip (the conversations view). */
  pin?: { isPinned: boolean; onToggle: (session: ProjectSession) => void };
  /** Given in the All view: the agent the session belongs to, marked with its letter. */
  agent?: { name: string; letter: string };
  /** How the session stands for the user: a second line, with the word and the reason. */
  mark?: SessionMark | null;
  /** Given in the overview, whose Now card lists what runs: true puts a pulsing dot in the marks' column, false shows none. */
  running?: boolean;
  /** A second line without a mark: a parent's worker counts. */
  detail?: string;
  /** What ends the second line: the session a worker belongs to. */
  context?: string;
  /** The row is one of a parent's workers. */
  nested?: boolean;
  /** Before the name: the arrow opening a parent's workers. */
  leading?: ReactNode;
  /** An older session (behind History): its name in the muted text colour, never dimmed. */
  older?: boolean;
  /** Row actions for what the session needs (answer, clear, archive, stop). */
  actions?: { onClear?: () => void; onArchive?: () => void; onStop?: () => void };
}

function StatusDot({ session, inAllView }: { session: ProjectSession; inAllView: boolean }) {
  const turns = useTurnStore();
  const state = inAllView
    ? allSessionState(session, turns.turns[session.id])
    : turns.turns[session.id]?.state ?? session.turnState ?? 'idle';
  // In the All view a result has its own row in To review, seen on any device.
  const unseenDone = !inAllView && isUnseenDone(turns, session.id);
  if (state !== 'working' && state !== 'waiting' && !unseenDone) return null;
  const title =
    state === 'working' ? 'Claude is working' : state === 'waiting' ? 'Waiting for your input' : 'Finished — not seen yet';
  return (
    <span title={title} className="absolute top-1/2 left-1 z-(--z-raised) flex -translate-y-1/2 items-center">
      <span
        className={cn('block size-1.5 rounded-full', state === 'working' ? 'animate-pulse bg-foreground' : state === 'waiting' ? 'bg-status-you' : 'bg-mark')}
      />
    </span>
  );
}

export function SidebarSessionRow({
  session,
  projectId,
  isSelected,
  now,
  renameDraft,
  onRenameDraftChange,
  onStartRename,
  onSaveRename,
  onCancelRename,
  onSelect,
  onRequestDelete,
  pin,
  agent,
  mark,
  running,
  detail,
  context,
  nested,
  leading,
  actions,
  older = false,
}: SessionRowProps) {
  const name = sessionDisplayName(session);
  const messageCount = Number(session.messageCount ?? 0);
  const age = compactAge(sessionTimeString(session), now);
  const menu = useRowMenu();
  // In the compact layout the menu does the renaming.
  const isRenaming = !menu && renameDraft !== null;
  const rowRef = useRef<HTMLDivElement>(null);
  const openMenu = () => menu?.open({ kind: 'session', session, projectId }, rowRef.current);
  const longPress = useLongPress(openMenu);
  const statusDot = !mark && running === undefined;
  const unread = Boolean(mark) && (!session.attention || !isRead(session));
  const noSummary = session.attention && mark !== 'result' ? ': no summary' : '';
  const reason = session.attention?.reason?.replace(/\s+/g, ' ').trim();
  const secondLine = mark
    ? [MARK_WORD[mark] + (reason ? `: ${reason}` : noSummary), context].filter(Boolean).join(' · ')
    : detail;

  return (
    <div ref={rowRef} className="group relative" {...(menu ? longPress : {})}>
      {statusDot && <StatusDot session={session} inAllView={Boolean(agent)} />}
      <button
        type="button"
        className={cn(
          ROW,
          'justify-start py-0 font-normal transition-colors duration-(--duration-fast) [&_svg]:size-3',
          secondLine ? (menu ? 'h-13 pr-10' : 'h-11') : menu ? 'h-10 pr-10' : 'h-7.5',
          // The status dot sits in the left padding, inside the row's highlight.
          nested ? 'pl-6' : statusDot && 'pl-3.5',
          isSelected && 'bg-muted',
        )}
        title={messageCount > 0 ? `${name} · ${messageCount} messages` : name}
        onClick={() => onSelect(session, projectId)}
      >
        <div className="flex w-full min-w-0 items-center gap-2">
          {leading}
          {mark && (
            <span
              aria-hidden="true"
              className={cn(
                'w-3 flex-shrink-0 text-center text-ui font-semibold',
                mark === 'failed' ? 'text-stopped-ink' : mark === 'question' || mark === 'waiting' ? 'text-you-ink' : 'text-foreground',
                !unread && 'text-muted-foreground',
              )}
            >
              {!unread && mark === 'review' ? '○' : MARK_SYMBOL[mark]}
            </span>
          )}
          {running && (
            <span title="Working" className="flex w-3 flex-shrink-0 justify-center">
              <span className="block size-1.5 animate-pulse rounded-full bg-foreground" />
            </span>
          )}
          {agent && (
            <span
              title={agent.name}
              className="flex size-4 flex-shrink-0 items-center justify-center rounded border border-border text-caption leading-none font-semibold text-muted-foreground"
            >
              {agent.letter}
            </span>
          )}
          {!mark && <SessionProviderLogo provider={session.__provider} className="size-3 flex-shrink-0" />}
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                !menu && (isRenaming ? 'pr-36' : pin ? 'group-hover:pr-22' : 'group-hover:pr-15'),
              )}
            >
              <span className={cn('min-w-0 truncate text-ui', older ? 'text-muted-foreground' : 'text-foreground', mark ? (unread ? 'font-semibold' : 'font-normal') : 'font-medium')}>{name}</span>
              {session.archivedAt && (
                <span className="flex-shrink-0 rounded-full border border-border px-1.5 text-caption text-muted-foreground">archived</span>
              )}
              {session.taskId && (
                <span
                  className="flex-shrink-0 rounded-full border border-border px-1.5 text-caption text-muted-foreground"
                  title="Task run — advances one task stage by stage"
                >
                  task
                </span>
              )}
              {menu?.isSessionPinned(session) && (
                <Pin aria-label="Pinned" className="flex-shrink-0 fill-current text-muted-foreground" />
              )}
              {age && (
                <span
                  className={cn(
                    'ml-auto flex-shrink-0 pl-1 text-caption text-muted-foreground tabular-nums',
                    !menu && 'group-hover:hidden',
                    isRenaming && 'hidden',
                  )}
                >
                  {age}
                </span>
              )}
            </div>
            {secondLine && (
              <div
                title={secondLine}
                className={cn(
                  'truncate text-caption font-normal',
                  mark === 'failed' ? 'text-stopped-ink' : 'text-muted-foreground',
                  !menu && (pin ? 'group-hover:pr-40' : 'group-hover:pr-32'),
                )}
              >
                {secondLine}
              </div>
            )}
          </div>
        </div>
      </button>

      {menu ? (
        <button
          type="button"
          aria-label={`Actions for ${name}`}
          className={cn('absolute top-0 right-0 flex size-10 items-center justify-center rounded-md text-muted-foreground active:text-foreground', FOCUS)}
          onClick={openMenu}
        >
          <MoreHorizontal aria-hidden className="size-4" />
        </button>
      ) : (
      <div
        className={cn(
          'absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 transition-opacity duration-(--duration-fast)',
          isRenaming ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100',
        )}
      >
        {isRenaming ? (
          <>
            <input
              type="text"
              value={renameDraft}
              autoFocus
              aria-label="Session name"
              onChange={(event) => onRenameDraftChange(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') onSaveRename();
                else if (event.key === 'Escape') onCancelRename();
              }}
              className={cn(FIELD, 'min-h-(--target-min) w-(--size-rename-field) rounded-md px-1.5 text-ui')}
            />
            <button
              type="button"
              title="Save"
              className={cn(CHIP, 'bg-muted text-foreground')}
              onClick={(event) => {
                event.stopPropagation();
                onSaveRename();
              }}
            >
              <Check className="size-3" />
            </button>
            <button
              type="button"
              title="Cancel"
              className={CHIP}
              onClick={(event) => {
                event.stopPropagation();
                onCancelRename();
              }}
            >
              <X className="size-3" />
            </button>
          </>
        ) : (
          <>
            {actions?.onStop && (
              <button type="button" title="Stop: ends the process, the conversation stays" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onStop?.(); }}>
                <Square className="size-3" />
              </button>
            )}
            {actions?.onClear && (
              <button type="button" title="Done: nothing left to do here" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onClear?.(); }}>
                <Check className="size-3" />
              </button>
            )}
            {actions?.onArchive && (
              <button type="button" title="Archive: leaves the lists, stays in search" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onArchive?.(); }}>
                <Archive className="size-3" />
              </button>
            )}
            {pin && (
              <button
                type="button"
                title={pin.isPinned ? 'Unpin session' : 'Pin session'}
                className={CHIP}
                onClick={(event) => {
                  event.stopPropagation();
                  pin.onToggle(session);
                }}
              >
                <Pin className={cn('size-3', pin.isPinned && 'fill-current')} />
              </button>
            )}
            <button
              type="button"
              title="Rename session"
              className={CHIP}
              onClick={(event) => {
                event.stopPropagation();
                onStartRename(session);
              }}
            >
              <Edit2 className="size-3" />
            </button>
            <button
              type="button"
              title="Delete session"
              className={cn(CHIP, CHIP_DELETE)}
              onClick={(event) => {
                event.stopPropagation();
                onRequestDelete(projectId, session);
              }}
            >
              <Trash2 className="size-3" />
            </button>
          </>
        )}
      </div>
      )}
    </div>
  );
}
