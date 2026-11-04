import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { Archive, Check, Edit2, Eye, EyeOff, FolderPlus, Pin, PinOff, Square, Trash2, type LucideIcon } from 'lucide-react';

import { APP_HEIGHT_VAR } from '@/hooks/useVisibleViewportHeight';
import { useArchiveNote, useRenameNote } from '@/lib/notes';
import { archiveSession, clearSession, stopSession } from '@/lib/session-actions';
import { cn } from '@/lib/utils';
import { forgetNoteInPanes } from '@/stores/usePaneStore';
import type { SidebarController } from '../../useSidebarController';
import { sessionDisplayName } from '../../utils';
import { rowMenuPosition, type RowMenuTarget } from '../rowMenuContext';

const SURFACE = 'rounded-2xl border border-border bg-popover/90 shadow-2xl backdrop-blur-xl select-none';
const WORD_BUTTON = 'min-h-11 flex-1 rounded-xl bg-foreground/[0.06] px-3 text-[15px] text-foreground active:bg-foreground/15 disabled:opacity-40';
const DESTRUCTIVE = 'text-destructive';

function targetName(target: RowMenuTarget): string {
  if (target.kind === 'session') return sessionDisplayName(target.session);
  if (target.kind === 'project') return target.project.displayName;
  return target.note.title;
}

function deleteWarning(target: RowMenuTarget): string {
  if (target.kind === 'note') return 'The note is archived in the brain.';
  return 'This stops the session and deletes its transcript. It cannot be undone.';
}

type Step = 'actions' | 'rename' | 'confirm';

/**
 * A row's actions on a phone: a small menu of icons at the row, closed by a tap
 * beside it. Delete asks in place; renaming is a dialog in the middle of the
 * visible viewport, like the app sized to end at the keyboard.
 */
export function SidebarRowMenu({
  target,
  row,
  controller,
  onClose,
}: {
  target: RowMenuTarget;
  row: DOMRect | null;
  controller: SidebarController;
  onClose: () => void;
}) {
  const renameNote = useRenameNote();
  const archiveNote = useArchiveNote();
  const [step, setStep] = useState<Step>('actions');
  const [noteDraft, setNoteDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu || !row) return;
    const view = { width: window.innerWidth, height: window.visualViewport?.height ?? window.innerHeight };
    setPosition(rowMenuPosition(row, { width: menu.offsetWidth, height: menu.offsetHeight }, view));
  }, [row, step]);

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

  const actions: Array<{ label: string; Icon: LucideIcon; onClick: () => void; destructive?: boolean }> = [];
  if (target.kind === 'session') {
    const pinned = controller.isSessionPinned(target.session);
    const { session } = target;
    const whenDone = (error: string | null) => { if (error) controller.reportError(error); };
    if (session.attention?.kind === 'review' || (session.attention && pinned)) actions.push({ label: 'Done', Icon: Check, onClick: run(() => void clearSession(session.id).then(whenDone)) });
    if (session.state === 'running' || session.state === 'detached') actions.push({ label: 'Stop', Icon: Square, onClick: run(() => void stopSession(session.id).then(whenDone)) });
    if (!session.archivedAt) actions.push({ label: 'Archive', Icon: Archive, onClick: run(() => void archiveSession(session.id).then(whenDone)) });
    actions.push(
      { label: pinned ? 'Unpin' : 'Pin', Icon: pinned ? PinOff : Pin, onClick: run(() => void controller.toggleSessionPin(target.session)) },
      { label: 'Rename', Icon: Edit2, onClick: startRename },
      { label: 'Delete', Icon: Trash2, onClick: () => setStep('confirm'), destructive: true },
    );
  } else if (target.kind === 'note') {
    actions.push(
      { label: 'Rename', Icon: Edit2, onClick: startRename },
      { label: 'Delete', Icon: Trash2, onClick: () => setStep('confirm'), destructive: true },
    );
  } else {
    const { project } = target;
    actions.push(
      { label: project.isStarred ? 'Unpin' : 'Pin', Icon: project.isStarred ? PinOff : Pin, onClick: run(() => void controller.toggleProjectStar(project)) },
      { label: 'Rename', Icon: Edit2, onClick: startRename },
    );
    if (project.kind === 'brain') {
      actions.push(
        { label: project.fullPath ? 'Change folder' : 'Link a folder', Icon: FolderPlus, onClick: run(() => controller.onSetFolder(project)) },
        { label: project.hidden ? 'Show' : 'Hide', Icon: project.hidden ? Eye : EyeOff, onClick: run(() => void controller.toggleProjectHidden(project)) },
      );
    } else {
      actions.push({ label: 'Remove from cockpit', Icon: Trash2, onClick: run(() => controller.requestProjectDelete(project)), destructive: true });
    }
  }

  return createPortal(
    <div
      className="fixed inset-x-0 top-0 z-[60] flex items-center justify-center bg-black/25 px-6"
      style={{ height: `var(${APP_HEIGHT_VAR}, 100dvh)` }}
      onClick={dismiss}
    >
      {step === 'rename' ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Rename ${targetName(target)}`}
          className={cn(SURFACE, 'w-full max-w-xs space-y-2 p-3')}
          onClick={(event) => event.stopPropagation()}
        >
          <input
            ref={inputRef}
            type="text"
            value={draft}
            aria-label="Name"
            enterKeyHint="done"
            onChange={(event) => onDraftChange(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && draft.trim()) saveRename(); }}
            // 16px or more: iOS zooms the page into a smaller field.
            className="min-h-11 w-full rounded-xl border border-border bg-background px-3 text-base text-foreground outline-none select-text focus:border-primary"
          />
          <div className="flex gap-2">
            <button type="button" className={WORD_BUTTON} onClick={dismiss}>Cancel</button>
            <button type="button" className={cn(WORD_BUTTON, 'font-medium')} disabled={!draft.trim()} onClick={saveRename}>Save</button>
          </div>
        </div>
      ) : (
        <div
          ref={menuRef}
          role={step === 'confirm' ? 'alertdialog' : 'menu'}
          aria-label={targetName(target)}
          className={cn(SURFACE, 'fixed', step === 'confirm' ? 'w-64 space-y-2 p-3' : 'flex items-center p-1', !position && 'invisible')}
          style={position ?? undefined}
          onClick={(event) => event.stopPropagation()}
        >
          {step === 'actions' ? actions.map(({ label, Icon, onClick, destructive }) => (
            <button
              key={label}
              type="button"
              role="menuitem"
              aria-label={label}
              className={cn(
                'flex h-11 w-12 items-center justify-center rounded-xl text-foreground active:bg-foreground/15',
                destructive && DESTRUCTIVE,
              )}
              onClick={onClick}
            >
              <Icon className="h-5 w-5" strokeWidth={1.8} />
            </button>
          )) : (
            <>
              <p className="truncate text-[15px] font-medium text-foreground">Delete “{targetName(target)}”?</p>
              <p className="text-[13px] text-muted-foreground">{deleteWarning(target)}</p>
              <div className="flex gap-2 pt-1">
                <button type="button" className={WORD_BUTTON} onClick={dismiss}>Cancel</button>
                <button type="button" className={cn(WORD_BUTTON, DESTRUCTIVE, 'font-medium')} onClick={confirmDelete}>Delete</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>,
    document.body,
  );
}
