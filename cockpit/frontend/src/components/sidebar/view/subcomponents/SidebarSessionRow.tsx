import { useRef, type ReactNode } from 'react';
import { Archive, Check, Edit2, MessageSquareReply, MoreHorizontal, Pin, Square, Trash2, X } from 'lucide-react';

import SessionProviderLogo from '@/components/llm-logo-provider/SessionProviderLogo';
import { useLongPress } from '@/hooks/useLongPress';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/view/ui';
import { isUnseenDone, useTurnStore } from '@/stores/useTurnStateStore';
import type { ProjectSession } from '@/types/app';
import { MARK_SYMBOL, MARK_WORD, allSessionState, isRead, type SessionMark } from '../../allSessions';
import { compactAge, sessionDisplayName, sessionTimeString } from '../../utils';
import { useRowMenu } from '../rowMenuContext';

const CHIP =
  'flex h-6 w-6 items-center justify-center rounded border border-border bg-background text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground';

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
  agent?: { letter: string; name: string };
  /** How the session stands for the user: a second line, with the word and the reason. */
  mark?: SessionMark | null;
  /** A second line without a mark: a parent's worker counts. */
  detail?: string;
  /** What leads the second line: the session a worker belongs to. */
  context?: string;
  /** The row is one of a parent's workers. */
  nested?: boolean;
  /** Before the name: the arrow opening a parent's workers. */
  leading?: ReactNode;
  /** Row actions for what the session needs (answer, clear, archive, stop). */
  actions?: { onAnswer?: () => void; onClear?: () => void; onArchive?: () => void; onStop?: () => void };
}

function StatusDot({ session, inAllView }: { session: ProjectSession; inAllView: boolean }) {
  const turns = useTurnStore();
  const state = inAllView
    ? allSessionState(session, turns.turns[session.id])
    : turns.turns[session.id]?.state ?? session.turnState ?? 'idle';
  const unseenDone = isUnseenDone(turns, session.id);
  if (state !== 'working' && state !== 'waiting' && !unseenDone) return null;
  const title =
    state === 'working' ? 'Claude is working' : state === 'waiting' ? 'Waiting for your input' : 'Finished — not seen yet';
  return (
    <span title={title} className="absolute top-1/2 -left-1.5 z-10 flex -translate-y-1/2 items-center">
      <span
        className={cn('block h-1.5 w-1.5 rounded-full', state === 'working' ? 'animate-pulse bg-foreground' : 'bg-primary')}
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
  detail,
  context,
  nested,
  leading,
  actions,
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
  const unread = Boolean(mark) && (!session.attention || !isRead(session));
  const reason = session.attention?.reason?.replace(/\s+/g, ' ').trim();
  const secondLine = mark
    ? [context, MARK_WORD[mark] + (reason ? `: ${reason}` : session.attention ? ': no summary' : '')].filter(Boolean).join(' · ')
    : detail;

  return (
    <div ref={rowRef} className="group relative" {...(menu ? longPress : {})}>
      {!mark && <StatusDot session={session} inAllView={Boolean(agent)} />}
      <Button
        variant="ghost"
        className={cn(
          'w-full justify-start px-2 py-0 text-left font-normal transition-colors duration-200 hover:bg-accent/50 [&_svg]:size-3',
          secondLine ? (menu ? 'h-13 pr-10' : 'h-11') : menu ? 'h-10 pr-10' : 'h-7.5',
          nested && 'pl-6',
          isSelected && 'bg-accent text-accent-foreground hover:bg-accent',
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
                'w-3 flex-shrink-0 text-center text-xs font-semibold',
                mark === 'failed' ? 'text-destructive' : 'text-primary',
                !unread && 'text-muted-foreground',
              )}
            >
              {!unread && (mark === 'review' || mark === 'done') ? '○' : MARK_SYMBOL[mark]}
            </span>
          )}
          {agent && (
            <span
              title={agent.name}
              className="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded border border-border text-[9px] font-semibold text-muted-foreground"
            >
              {agent.letter}
            </span>
          )}
          <SessionProviderLogo provider={session.__provider} className="h-3 w-3 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                !menu && (isRenaming ? 'pr-36' : pin ? 'group-hover:pr-22' : 'group-hover:pr-15'),
              )}
            >
              <span className={cn('min-w-0 truncate text-xs text-foreground', mark ? (unread ? 'font-semibold' : 'font-normal') : 'font-medium')}>{name}</span>
              {session.archivedAt && (
                <span className="flex-shrink-0 rounded-full border border-border px-1.5 text-[9px] leading-4 text-muted-foreground">archived</span>
              )}
              {session.taskId && (
                <span
                  className="flex-shrink-0 rounded-full border border-border px-1.5 text-[9px] leading-4 text-muted-foreground"
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
                    'ml-auto flex-shrink-0 pl-1 text-[10px] text-muted-foreground',
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
                  'truncate text-[11px] leading-4 font-normal',
                  mark === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                  !menu && (pin ? 'group-hover:pr-40' : 'group-hover:pr-32'),
                )}
              >
                {secondLine}
              </div>
            )}
          </div>
        </div>
      </Button>

      {menu ? (
        <button
          type="button"
          aria-label={`Actions for ${name}`}
          className="absolute top-0 right-0 flex h-10 w-10 items-center justify-center text-muted-foreground active:text-foreground"
          onClick={openMenu}
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      ) : (
      <div
        className={cn(
          'absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1 transition-opacity duration-200',
          isRenaming ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
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
              className="w-[8ch] rounded border border-border bg-background px-1.5 py-0.5 text-xs text-foreground focus:ring-1 focus:ring-primary focus:outline-none"
            />
            <button
              type="button"
              title="Save"
              className="flex h-6 w-6 items-center justify-center rounded bg-muted text-foreground transition-colors hover:bg-accent dark:bg-foreground/10"
              onClick={(event) => {
                event.stopPropagation();
                onSaveRename();
              }}
            >
              <Check className="h-3 w-3" />
            </button>
            <button
              type="button"
              title="Cancel"
              className="flex h-6 w-6 items-center justify-center rounded bg-foreground/5 text-muted-foreground transition-colors hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onCancelRename();
              }}
            >
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <>
            {actions?.onAnswer && (
              <button type="button" title="Answer" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onAnswer?.(); }}>
                <MessageSquareReply className="h-3 w-3" />
              </button>
            )}
            {actions?.onStop && (
              <button type="button" title="Stop: ends the process, the conversation stays" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onStop?.(); }}>
                <Square className="h-3 w-3" />
              </button>
            )}
            {actions?.onClear && (
              <button type="button" title="Clear: nothing left to do here" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onClear?.(); }}>
                <Check className="h-3 w-3" />
              </button>
            )}
            {actions?.onArchive && (
              <button type="button" title="Archive: leaves the lists, stays in search" className={CHIP} onClick={(event) => { event.stopPropagation(); actions.onArchive?.(); }}>
                <Archive className="h-3 w-3" />
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
                <Pin className={cn('h-3 w-3', pin.isPinned && 'fill-current')} />
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
              <Edit2 className="h-3 w-3" />
            </button>
            <button
              type="button"
              title="Delete session"
              className={cn(CHIP, 'hover:border-destructive/60 hover:text-destructive')}
              onClick={(event) => {
                event.stopPropagation();
                onRequestDelete(projectId, session);
              }}
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </>
        )}
      </div>
      )}
    </div>
  );
}
