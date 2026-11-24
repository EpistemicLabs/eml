// A file pinned to the desk from the media viewer ("Open as pane", mockup v3): its name and path
// on top, the file below. The pane keeps the path with the layout; the file is looked up again on
// each start, so a moved or deleted file says so instead of showing stale content.
import type { ReactNode } from 'react';

import { useFileStats } from './files';
import { MediaView } from './MediaView';

export function FilePane({ filePath, toolbar }: { filePath: string; toolbar: ReactNode }) {
  const { data, isPending } = useFileStats([filePath], null);
  const file = data?.[0];
  const name = filePath.slice(filePath.lastIndexOf('/') + 1);
  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col pt-2 pr-40 pb-1 pl-4">
        <b className="truncate text-heading font-semibold">{name}</b>
        <span className="truncate font-code text-caption text-muted-foreground" title={filePath}>{filePath}</span>
      </header>
      <div className="pointer-events-auto absolute top-0 right-0 z-(--z-pane-toolbar) pt-2 pr-2 pb-1 sm:pr-3">{toolbar}</div>
      <div className="flex min-h-0 flex-1 flex-col px-3 pt-2 pb-3">
        {file ? <MediaView file={file} /> : (
          <p className="m-auto px-4 text-center text-body text-muted-foreground">
            {isPending ? 'Loading…' : 'This file is not there anymore, or it can no longer be shown.'}
          </p>
        )}
      </div>
    </div>
  );
}
