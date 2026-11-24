// The file slide-over (mockup v3): the file alone when its chat is on screen (a chip), wide with
// the chat it comes from beside it when found with ⌘K. ← → and the tabs flip through the chat's
// files, Esc closes, "Open as pane" pins the file to the desk (a file pane, kept with the layout).
import { ChevronLeft, ChevronRight, PanelRight, X } from 'lucide-react';
import { useEffect } from 'react';

import { useAllSessions } from '@/components/sidebar/useAllSessions';
import { SessionChat } from '@/components/ui/session-chat';
import { cn } from '@/lib/utils';
import { Button, TAB } from '@/shared/view/ui';
import { Sheet } from '@/shared/view/ui/Sheet';
import { openInPane } from '@/stores/usePaneStore';
import { paneSpaceKey, useSpaces } from '@/stores/useSpaceStore';

import { formatSize, typeLabel } from './file-refs';
import { closeMedia, showMediaAt, stepMedia, useMediaOpen, type SourceChat } from './files';
import { MediaView } from './MediaView';

const TITLE_ID = 'media-title';
/** The surface the source chat shows in (scroll and draft are kept per surface). */
export const MEDIA_PANE_ID = 'media';

/** Whether a key press belongs to a field (its arrows move the caret, not the file). */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || !!target.closest('.xterm');
}

function SourceChatPanel({ chat }: { chat: SourceChat }) {
  const { sessions } = useAllSessions(true);
  const spaces = useSpaces();
  const session = sessions?.find((s) => s.id === chat.sessionId);
  const space = spaces.find((s) => s.id === (session?.spaceId ?? chat.spaceId));
  return (
    <section aria-label="The chat this file comes from" className="flex min-h-0 min-w-(--size-media-chat) flex-2 flex-col overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex shrink-0 flex-col border-b border-border px-4 py-2">
        <b className="truncate text-heading font-semibold">{chat.title}</b>
        <span className="text-ui text-muted-foreground">the chat this file comes from</span>
      </header>
      {session ? (
        <SessionChat
          key={session.id}
          paneId={MEDIA_PANE_ID}
          projectId={session.__projectId ?? session.projectId ?? chat.projectId}
          sessionId={session.id}
          session={session}
          spaceId={space ? paneSpaceKey(space) : null}
          borrowed
        />
      ) : (
        <p className="m-auto p-6 text-center text-body text-muted-foreground">{sessions ? 'This chat is no longer in the list.' : 'Loading the chat…'}</p>
      )}
    </section>
  );
}

export function FileSlideOver() {
  const open = useMediaOpen();
  const file = open ? open.files[open.index] : undefined;

  useEffect(() => {
    if (!open || open.files.length < 2) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); stepMedia(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); stepMedia(1); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const pin = () => {
    if (!file) return;
    closeMedia();
    openInPane({ surface: 'file', projectId: open?.chat?.projectId ?? null, filePath: file.path });
  };

  const many = (open?.files.length ?? 0) > 1;
  return (
    <Sheet
      open={Boolean(open && file)}
      onClose={closeMedia}
      labelledBy={TITLE_ID}
      className={cn('gap-0 p-0', open?.chat && 'max-w-(--container-sheet-wide)')}
    >
      {open && file && (
        <>
          <header className="flex shrink-0 flex-wrap items-center gap-2.5 border-b border-border py-2.5 pr-3 pl-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <h2 id={TITLE_ID} className="m-0 truncate text-heading font-semibold">{file.name}</h2>
              <span className="truncate font-code text-caption text-muted-foreground" title={file.path}>{file.path} · {formatSize(file.size)}</span>
            </div>
            {many && (
              <span className="inline-flex items-center gap-0.5 rounded-(--radius-track) bg-muted p-(--pad-track)">
                <Button variant="ghost" size="icon-sm" aria-label="Previous file" disabled={open.index === 0} onClick={() => stepMedia(-1)}><ChevronLeft /></Button>
                <span className="px-1.5 text-ui text-muted-foreground tabular-nums">{open.index + 1} / {open.files.length}</span>
                <Button variant="ghost" size="icon-sm" aria-label="Next file" disabled={open.index === open.files.length - 1} onClick={() => stepMedia(1)}><ChevronRight /></Button>
              </span>
            )}
            <Button size="sm" onClick={pin}><PanelRight aria-hidden /> Open as pane</Button>
            <Button variant="ghost" size="icon" aria-label="Close (Esc)" onClick={closeMedia}><X /></Button>
          </header>
          {many && (
            <div role="tablist" aria-label="Files" className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
              {open.files.map((f, i) => (
                <button key={f.path} type="button" role="tab" aria-selected={i === open.index} onClick={() => showMediaAt(i)} className={cn(TAB, 'text-ui')}>
                  <span className="font-code text-caption uppercase">{typeLabel(f.path)}</span>
                  {f.name}
                </button>
              ))}
            </div>
          )}
          <div className={cn('flex min-h-0 flex-1 gap-3 p-4', open.chat ? 'max-lg:flex-col' : '')}>
            <div className="flex min-h-0 min-w-0 flex-3 flex-col">
              <MediaView file={file} />
            </div>
            {open.chat && <SourceChatPanel chat={open.chat} />}
          </div>
        </>
      )}
    </Sheet>
  );
}
