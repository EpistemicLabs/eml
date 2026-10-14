import { Check, Edit2, Pin, Trash2, X } from 'lucide-react';

import SessionProviderLogo from '@/components/llm-logo-provider/SessionProviderLogo';
import { cn } from '@/lib/utils';
import { Button } from '@/shared/view/ui';
import { isUnseenDone, useTurnStore } from '@/stores/useTurnStateStore';
import type { ProjectSession } from '@/types/app';
import { compactAge, sessionDisplayName, sessionTimeString } from '../../utils';

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
}

function StatusDot({ session }: { session: ProjectSession }) {
  const turns = useTurnStore();
  const state = turns.turns[session.id]?.state ?? session.turnState ?? 'idle';
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
}: SessionRowProps) {
  const name = sessionDisplayName(session);
  const messageCount = Number(session.messageCount ?? 0);
  const age = compactAge(sessionTimeString(session), now);
  const isRenaming = renameDraft !== null;

  return (
    <div className="group relative">
      <StatusDot session={session} />
      <Button
        variant="ghost"
        className={cn(
          'h-7.5 w-full justify-start px-2 py-0 text-left font-normal transition-colors duration-200 hover:bg-accent/50 [&_svg]:size-3',
          isSelected && 'bg-accent text-accent-foreground hover:bg-accent',
        )}
        title={messageCount > 0 ? `${name} · ${messageCount} messages` : name}
        onClick={() => onSelect(session, projectId)}
      >
        <div className="flex w-full min-w-0 items-center gap-2">
          <SessionProviderLogo provider={session.__provider} className="h-3 w-3 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <div
              className={cn(
                'flex min-w-0 items-center gap-1.5',
                isRenaming ? 'pr-36' : pin ? 'group-hover:pr-22' : 'group-hover:pr-15',
              )}
            >
              <span className="min-w-0 truncate text-xs font-medium text-foreground">{name}</span>
              {session.taskId && (
                <span
                  className="flex-shrink-0 rounded-full border border-border px-1.5 text-[9px] leading-4 text-muted-foreground"
                  title="Task run — advances one task stage by stage"
                >
                  task
                </span>
              )}
              {age && (
                <span
                  className={cn(
                    'ml-auto flex-shrink-0 pl-1 text-[10px] text-muted-foreground group-hover:hidden',
                    isRenaming && 'hidden',
                  )}
                >
                  {age}
                </span>
              )}
            </div>
          </div>
        </div>
      </Button>

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
    </div>
  );
}
