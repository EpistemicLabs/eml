// Kept: displayed name = user override → session summary → auto label;
// inline rename (click the title, Enter/Escape/blur) persisted on the pane
// via renamePane AND pushed to the session record (host ledger) so the
// sidebar shows the same name; deferred promotion of a local override once
// the session record appears. Trimmed: tab titles (files/git/tasks/plugins),
// the provider logo, i18n.
// 0.15.1: one name per view. A pane that holds a session and a note keeps
// them apart — the terminal view shows (and renames) the session, the note
// view shows (and renames) the note itself, never the other way round.
import { useEffect, useRef, useState } from 'react';

import { usePaletteOps } from '@/contexts/PaletteOpsContext';
import { useNote, useRenameNote } from '@/lib/notes';
import { useProviders } from '@/lib/providers';
import SessionProviderLogo from '../../../llm-logo-provider/SessionProviderLogo';
import { usePane, renamePane } from '@/stores/usePaneStore';
import { endPaneDrag, startPaneDrag } from '@/components/app/paneDrag';
import type { Project, ProjectSession } from '@/types/app';
import { api } from '@/utils/api';

type MainContentTitleProps = {
  /** Owning pane id — enables inline rename. */
  paneId: string;
  /** The pane's project — its display name is the subtitle. */
  selectedProject: Project | null;
  /** The pane's session record from the host (null until it is listed). */
  selectedSession: ProjectSession | null;
  /**
   * Pane-local fallback label (e.g. "Terminal 2") shown when the user hasn't
   * chosen a title. Distinguishes parallel panes.
   */
  paneLabel?: string | null;
};

// The stored session name — the ledger title. Used as the edit seed and the
// "did it change?" check (distinct from the displayed title, which falls back
// to the transcript summary and then a pane label).
function getStoredSessionName(session: ProjectSession): string {
  return (session.title as string | null | undefined) || '';
}

function getSessionTitle(session: ProjectSession, paneLabel?: string | null): string {
  return (session.summary as string) || paneLabel || 'New Session';
}

export default function MainContentTitle({ paneId, selectedProject, selectedSession, paneLabel }: MainContentTitleProps) {
  const { refreshProjects } = usePaletteOps();

  // Live pane from the store: holds the user-chosen `title` override and the
  // pre-minted `sessionId` (present even when `selectedSession` is still null
  // because the host hasn't listed the session yet).
  const pane = usePane(paneId);
  const overrideTitle = pane?.title;
  // Note panes are named after their note's first line.
  const isNoteView = pane?.paneView === 'note';
  const { data: note } = useNote(isNoteView ? pane.noteId : null);
  const renameNote = useRenameNote();
  // The pane's own title belongs to its session (terminal) or to a pure brain
  // pane; a session pane in brain view stays "Brain" and is not renamed.
  const canRename = isNoteView ? Boolean(note) : !(pane?.paneView === 'brain' && pane.sessionId);
  const sessionId = selectedSession?.id ?? pane?.sessionId ?? null;
  // Promote a pending local override to the host at most once per
  // (sessionId, name) pair, so the effect can't loop on refreshProjects.
  const promotedRef = useRef<string | null>(null);

  // Inline rename: click the title to edit it in place.
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef(false);

  // The current effective editable name (override wins over the stored name).
  const currentName = isNoteView
    ? (note?.title ?? '')
    : (overrideTitle ?? (selectedSession ? getStoredSessionName(selectedSession) : ''));

  // Leaving edit mode when the pane switches session/identity avoids carrying
  // a half-typed name onto the wrong conversation.
  useEffect(() => {
    setIsEditing(false);
    setDraft('');
  }, [sessionId, paneId]);

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [isEditing]);

  // Deferred promotion: once a pane that carries a local override resolves to
  // a listed session (the terminal ran and the host indexed it), push the
  // name to the session record so it also shows in the sidebar.
  useEffect(() => {
    if (pane?.paneView !== 'terminal' || !selectedSession || !overrideTitle) return;
    if (getStoredSessionName(selectedSession) === overrideTitle) return;
    const key = `${selectedSession.id}:${overrideTitle}`;
    if (promotedRef.current === key) return;
    promotedRef.current = key;
    void (async () => {
      try {
        const response = await api.renameSession(selectedSession.id, overrideTitle);
        if (response.ok) await refreshProjects();
      } catch {
        // Will retry when the override or session changes.
      }
    })();
  }, [pane?.paneView, selectedSession, overrideTitle, refreshProjects]);

  // Displayed pane name: user override → session summary → auto label.
  const title = pane?.paneView === 'brain'
    ? (pane.sessionId ? 'Brain' : (overrideTitle ?? 'Brain'))
    : isNoteView
    ? (note?.title ?? 'Notes')
    : (overrideTitle ?? (selectedSession ? getSessionTitle(selectedSession, paneLabel) : (paneLabel || 'New Session')));
  // Brain panes show the project they are scoped to, like terminal panes do;
  // a brain-wide pane (no project) names the instance — for now there is only
  // one ("Main"), hosted/other instances come later.
  const subtitle = pane?.paneView === 'brain'
    ? selectedProject?.displayName ?? 'Main'
    : selectedProject?.displayName ?? '';

  // Which agent CLI the pane's session runs with: what the host recorded, else
  // what the pane will start with. Shown once there is more than one to tell apart.
  const providers = useProviders().data ?? [];
  const provider = pane?.paneView === 'terminal'
    ? selectedSession?.__provider ?? pane.provider ?? providers.find((p) => p.isDefault)?.id
    : undefined;
  const showProvider = Boolean(provider) && providers.filter((p) => p.version !== null).length > 1;

  const startEditing = () => {
    if (!canRename) return;
    setDraft(currentName || title);
    setIsEditing(true);
  };

  const commitRename = async () => {
    setIsEditing(false);
    const trimmed = draft.trim();
    if (!trimmed || trimmed === currentName) return;
    if (isNoteView) {
      if (pane?.noteId) renameNote.mutate({ id: pane.noteId, title: trimmed });
      return;
    }
    // 1. Instant, persisted, always-available: store the override on the pane.
    renamePane(paneId, trimmed);
    // 2. Best-effort host rename when a session record may exist. A 404
    //    (session not spawned yet) is expected and swallowed — the promotion
    //    effect retries once the record appears.
    if (pane?.paneView === 'terminal' && sessionId) {
      try {
        const response = await api.renameSession(sessionId, trimmed);
        if (response.ok) await refreshProjects();
      } catch {
        // Non-fatal — the local override already shows the new name.
      }
    }
  };

  return (
    <div className="scrollbar-hide flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
      <div className="min-w-0 flex-1">
        <div className="min-w-0">
          {isEditing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  cancelRef.current = false;
                  event.currentTarget.blur();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelRef.current = true;
                  event.currentTarget.blur();
                }
              }}
              onBlur={() => {
                if (cancelRef.current) {
                  cancelRef.current = false;
                  setIsEditing(false);
                  return;
                }
                void commitRename();
              }}
              placeholder="Pane name"
              aria-label="Pane name"
              className="w-full min-w-0 rounded border border-border bg-transparent px-1 py-0.5 text-body leading-tight font-semibold text-foreground outline-none focus:border-foreground/40"
            />
          ) : (
            // Drag the title onto a desk tab to move the pane there (pinned panes stay put).
            <div
              className="flex min-w-0 items-center"
              draggable={!pane?.pinned}
              onDragStart={(event) => startPaneDrag(event, paneId)}
              onDragEnd={endPaneDrag}
            >
            {showProvider && (
              <span className="ml-1 flex-shrink-0 text-muted-foreground" title={providers.find((p) => p.id === provider)?.label}>
                <SessionProviderLogo provider={provider} className="h-3 w-3" />
              </span>
            )}
            <h2
              role={canRename ? 'button' : undefined}
              tabIndex={canRename ? 0 : undefined}
              onClick={startEditing}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  startEditing();
                }
              }}
              title={[
                canRename && (isNoteView ? 'Click to rename the note' : 'Click to rename'),
                !pane?.pinned && 'drag onto a desk tab to move the pane',
              ].filter(Boolean).join(' · ') || undefined}
              className={`${canRename ? 'cursor-text hover:bg-foreground/5' : ''} truncate rounded px-1 text-body leading-tight font-semibold text-foreground transition-colors`}
            >
              {title}
            </h2>
            </div>
          )}
          <div className="truncate px-1 text-caption leading-tight text-muted-foreground">{subtitle}</div>
        </div>
      </div>
    </div>
  );
}
