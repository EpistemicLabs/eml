import { useRef, useState, type TouchEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Edit2, Eye, EyeOff, FolderPlus, Pin, PinOff, Trash2, type LucideIcon } from 'lucide-react';

import { readSwipe } from '@/hooks/swipeGesture';
import { useSoftKeyboardOpen } from '@/hooks/useSoftKeyboardOpen';
import { APP_HEIGHT_VAR } from '@/hooks/useVisibleViewportHeight';
import { useArchiveNote, useRenameNote } from '@/lib/notes';
import { cn } from '@/lib/utils';
import { forgetNoteInPanes } from '@/stores/usePaneStore';
import type { SidebarController } from '../../useSidebarController';
import { sessionDisplayName } from '../../utils';
import type { RowSheetTarget } from '../rowSheetContext';

const ACTION = 'flex min-h-12 w-full items-center justify-center rounded-xl bg-foreground/[0.06] px-4 text-base text-foreground active:bg-foreground/15 disabled:opacity-40';
const DESTRUCTIVE = 'text-destructive';
const TILE = 'flex min-h-[72px] min-w-0 flex-col items-center justify-center gap-1.5 rounded-xl bg-foreground/[0.06] px-1 text-[13px] text-foreground active:bg-foreground/15';

function targetName(target: RowSheetTarget): string {
  if (target.kind === 'session') return sessionDisplayName(target.session);
  if (target.kind === 'project') return target.project.displayName;
  return target.note.title;
}

function deleteWarning(target: RowSheetTarget): string {
  if (target.kind === 'note') return 'The note is archived in the brain.';
  return 'This stops the session and deletes its transcript. It cannot be undone.';
}

type Step = 'actions' | 'rename' | 'confirm';

/**
 * A row's actions on a phone, in a sheet at the bottom with large targets. It is
 * sized to the visible viewport, like the app, so it sits on top of the keyboard
 * while renaming. Swipe down, tap beside it or Cancel dismisses it.
 */
export function SidebarRowSheet({
  target,
  controller,
  onClose,
}: {
  target: RowSheetTarget;
  controller: SidebarController;
  onClose: () => void;
}) {
  const keyboardOpen = useSoftKeyboardOpen();
  const renameNote = useRenameNote();
  const archiveNote = useArchiveNote();
  const [step, setStep] = useState<Step>('actions');
  const [noteDraft, setNoteDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const dismiss = () => {
    if (step === 'rename') {
      if (target.kind === 'session') controller.cancelSessionRename();
      else if (target.kind === 'project') controller.cancelProjectRename();
    }
    onClose();
  };
  const run = (action: () => void) => () => {
    action();
    onClose();
  };

  // iOS raises the keyboard only for a focus() made inside the tap's own handler.
  const startRename = () => {
    flushSync(() => {
      if (target.kind === 'session') controller.startSessionRename(target.session);
      else if (target.kind === 'project') controller.startProjectRename(target.project);
      else setNoteDraft(target.note.title);
      setStep('rename');
    });
    inputRef.current?.focus();
    inputRef.current?.select();
  };

  const draft =
    target.kind === 'session' ? controller.sessionRename?.draft ?? ''
    : target.kind === 'project' ? controller.projectRename?.draft ?? ''
    : noteDraft;
  const onDraftChange = (value: string) => {
    if (target.kind === 'session') controller.setSessionRenameDraft(value);
    else if (target.kind === 'project') controller.setProjectRenameDraft(value);
    else setNoteDraft(value);
  };
  const saveRename = () => {
    if (target.kind === 'session') void controller.saveSessionRename();
    else if (target.kind === 'project') void controller.saveProjectRename();
    else {
      const title = noteDraft.trim();
      if (title && title !== target.note.title) renameNote.mutate({ id: target.note.id, title });
    }
    onClose();
  };
  const confirmDelete = () => {
    if (target.kind === 'session') void controller.deleteSession(target.session.id);
    else if (target.kind === 'note') {
      const { note } = target;
      archiveNote.mutate(note, { onSuccess: () => forgetNoteInPanes(note.id) });
    }
    onClose();
  };

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    swipeStart.current = touch && event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null;
  };
  const onTouchMove = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || !swipeStart.current) return;
    const reading = readSwipe(touch.clientX - swipeStart.current.x, touch.clientY - swipeStart.current.y, 'down');
    if (reading === 'commit') dismiss();
    if (reading !== 'pending') swipeStart.current = null;
  };

  const tiles: Array<{ label: string; Icon: LucideIcon; onClick: () => void; destructive?: boolean }> = [];
  if (target.kind === 'session') {
    const pinned = controller.isSessionPinned(target.session);
    tiles.push(
      { label: pinned ? 'Unpin' : 'Pin', Icon: pinned ? PinOff : Pin, onClick: run(() => void controller.toggleSessionPin(target.session)) },
      { label: 'Rename', Icon: Edit2, onClick: startRename },
      { label: 'Delete', Icon: Trash2, onClick: () => setStep('confirm'), destructive: true },
    );
  } else if (target.kind === 'note') {
    tiles.push(
      { label: 'Rename', Icon: Edit2, onClick: startRename },
      { label: 'Delete', Icon: Trash2, onClick: () => setStep('confirm'), destructive: true },
    );
  } else {
    const { project } = target;
    tiles.push(
      { label: project.isStarred ? 'Unpin' : 'Pin', Icon: project.isStarred ? PinOff : Pin, onClick: run(() => void controller.toggleProjectStar(project)) },
      { label: 'Rename', Icon: Edit2, onClick: startRename },
    );
    if (project.kind === 'brain') {
      tiles.push(
        { label: 'Folder', Icon: FolderPlus, onClick: run(() => controller.onSetFolder(project)) },
        { label: project.hidden ? 'Show' : 'Hide', Icon: project.hidden ? Eye : EyeOff, onClick: run(() => void controller.toggleProjectHidden(project.projectId)) },
      );
    } else {
      tiles.push({ label: 'Remove', Icon: Trash2, onClick: run(() => controller.requestProjectDelete(project)), destructive: true });
    }
  }

  return createPortal(
    <div
      className="fixed inset-x-0 top-0 z-[60] flex flex-col justify-end bg-black/50"
      style={{ height: `var(${APP_HEIGHT_VAR}, 100dvh)` }}
      onClick={dismiss}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={targetName(target)}
        className={cn(
          'space-y-2 rounded-t-2xl border-t border-border bg-popover px-3 pt-2 select-none',
          keyboardOpen ? 'pb-3' : 'pb-[max(0.75rem,env(safe-area-inset-bottom))]',
        )}
        onClick={(event) => event.stopPropagation()}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
      >
        <div aria-hidden className="mx-auto h-1 w-9 rounded-full bg-foreground/25" />
        <div className="truncate px-1 py-1 text-center text-sm font-medium text-muted-foreground">
          {step === 'confirm' ? `Delete “${targetName(target)}”?` : targetName(target)}
        </div>
        {step === 'actions' && (
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${tiles.length}, minmax(0, 1fr))` }}>
            {tiles.map(({ label, Icon, onClick, destructive }) => (
              <button key={label} type="button" className={cn(TILE, destructive && DESTRUCTIVE)} onClick={onClick}>
                <Icon className="h-5 w-5" strokeWidth={1.8} />
                {label}
              </button>
            ))}
          </div>
        )}
        {step === 'rename' && (
          <>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              aria-label="Name"
              enterKeyHint="done"
              onChange={(event) => onDraftChange(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') saveRename(); }}
              // 16px or more: iOS zooms the page into a smaller field.
              className="min-h-12 w-full rounded-xl border border-border bg-background px-3 text-base text-foreground outline-none select-text focus:border-primary"
            />
            <button type="button" className={ACTION} disabled={!draft.trim()} onClick={saveRename}>Save</button>
          </>
        )}
        {step === 'confirm' && (
          <>
            <p className="px-1 pb-1 text-center text-sm text-muted-foreground">{deleteWarning(target)}</p>
            <button type="button" className={cn(ACTION, DESTRUCTIVE)} onClick={confirmDelete}>Delete</button>
          </>
        )}
        <button type="button" className={cn(ACTION, 'font-medium')} onClick={dismiss}>Cancel</button>
      </div>
    </div>,
    document.body,
  );
}
