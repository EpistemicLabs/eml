// One file, shown by its kind (mockup v3): a CSV as a table to sort and filter, an image to zoom,
// a PDF in the browser's own viewer, Markdown as a preview or its source. The slide-over and a file
// pane both show it; it reads the file from the host (GET /api/file).
import { useQuery } from '@tanstack/react-query';
import { memo, useMemo, useState } from 'react';
import { Streamdown } from 'streamdown';

import { replyRehypePlugins } from '@/components/chat/reply-markdown';
import { cn } from '@/lib/utils';
import { Button, FIELD, TAB, TRACK } from '@/shared/view/ui';

import { nextSort, toTable, viewRows, type View } from './csv';
import { extensionOf, formatSize } from './file-refs';
import { fileUrl, type FileInfo } from './files';

/** Text files above this open as a note instead: a table or preview of it would hang the page. */
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
/** Rows a table draws; the filter reaches the rest. */
const MAX_ROWS = 2000;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];

const BAR = 'flex flex-wrap items-center gap-2 text-ui text-muted-foreground';

function useFileText(file: FileInfo) {
  return useQuery({
    queryKey: ['file-text', file.path, file.modifiedAt],
    queryFn: async () => {
      const res = await fetch(fileUrl(file.path));
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? `The file could not be read (${res.status}).`);
      }
      return res.text();
    },
    enabled: file.size <= MAX_TEXT_BYTES,
    staleTime: 10_000,
    retry: false,
  });
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="m-auto max-w-(--container-measure) px-4 py-10 text-center text-body text-muted-foreground">{children}</p>;
}

function TooLarge({ file }: { file: FileInfo }) {
  return <Note>{file.name} is {formatSize(file.size)}, too large to show here.</Note>;
}

function TextState({ query }: { query: ReturnType<typeof useFileText> }) {
  if (query.isError) return <Note>{query.error.message}</Note>;
  return <Note>Loading…</Note>;
}

function CsvView({ file }: { file: FileInfo }) {
  const text = useFileText(file);
  const table = useMemo(() => (text.data !== undefined ? toTable(text.data, extensionOf(file.path) === 'tsv') : null), [text.data, file.path]);
  const [view, setView] = useState<View>({ filter: '', sort: null });
  const rows = useMemo(() => (table ? viewRows(table, view) : []), [table, view]);
  if (file.size > MAX_TEXT_BYTES) return <TooLarge file={file} />;
  if (!table) return <TextState query={text} />;
  const shown = rows.slice(0, MAX_ROWS);
  const count = view.filter ? `${rows.length} of ${table.rows.length} rows` : `${table.rows.length} rows`;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className={BAR}>
        <span>CSV · {count}{rows.length > MAX_ROWS ? ` · the first ${MAX_ROWS} shown` : ''}</span>
        <span className="flex-1" />
        <input
          type="search"
          value={view.filter}
          onChange={(event) => setView((prev) => ({ ...prev, filter: event.target.value }))}
          placeholder="Filter rows"
          aria-label="Filter rows"
          className={cn(FIELD, 'w-(--size-media-filter) max-w-full')}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-border bg-card">
        <table className="w-full border-collapse text-left text-body tabular-nums">
          <thead>
            <tr>
              {table.head.map((name, column) => {
                const sorted = view.sort?.column === column ? view.sort.dir : 0;
                return (
                  <th
                    key={column}
                    scope="col"
                    aria-sort={sorted === 1 ? 'ascending' : sorted === -1 ? 'descending' : undefined}
                    className={cn('sticky top-0 z-(--z-raised) border-b border-border bg-muted p-0 text-ui font-semibold whitespace-nowrap', sorted ? 'text-foreground' : 'text-muted-foreground')}
                  >
                    <button
                      type="button"
                      onClick={() => setView((prev) => ({ ...prev, sort: nextSort(prev.sort, column) }))}
                      className={cn('flex min-h-(--target-comfortable) w-full items-center gap-1 px-3', table.numeric[column] && 'justify-end')}
                    >
                      {name}
                      {sorted !== 0 && <span aria-hidden>{sorted === 1 ? '▲' : '▼'}</span>}
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r} className="border-b border-border last:border-b-0">
                {table.head.map((_, c) => (
                  <td key={c} className={cn('px-3 py-1.5 whitespace-nowrap', table.numeric[c] && 'text-right')}>{row[c] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && <Note>No row holds “{view.filter}”.</Note>}
      </div>
    </div>
  );
}

function ImageView({ file }: { file: FileInfo }) {
  // null: fit the stage; a number: that zoom of the image's own size.
  const [zoom, setZoom] = useState<number | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // The scale the image shows at while it fits the stage, measured when it loads.
  const [fitted, setFitted] = useState(1);
  const current = zoom ?? fitted;
  const step = (delta: 1 | -1) => {
    const at = ZOOM_STEPS.findIndex((z) => z >= current);
    const index = Math.max(0, Math.min(ZOOM_STEPS.length - 1, (at === -1 ? ZOOM_STEPS.length - 1 : at) + delta));
    setZoom(ZOOM_STEPS[index]);
  };
  const src = `${fileUrl(file.path)}&v=${encodeURIComponent(file.modifiedAt)}`;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className={BAR}>
        <span>Image{size ? ` · ${size.w} × ${size.h}` : ''}</span>
        <span className="flex-1" />
        <Button variant="outline" size="sm" aria-label="Zoom out" onClick={() => step(-1)}>−</Button>
        <span className="min-w-10 text-center tabular-nums" aria-live="polite">{Math.round(current * 100)}%</span>
        <Button variant="outline" size="sm" aria-label="Zoom in" onClick={() => step(1)}>+</Button>
        <Button variant="outline" size="sm" aria-pressed={zoom === null} onClick={() => setZoom(null)}>Fit</Button>
      </div>
      <div className={cn('min-h-(--size-media-stage) flex-1 overflow-auto rounded-xl bg-muted p-4', zoom === null && 'grid place-items-center')}>
        {failed ? <Note>The image could not be shown.</Note> : (
          <img
            src={src}
            alt={file.name}
            onLoad={(event) => {
              const img = event.currentTarget;
              setSize({ w: img.naturalWidth, h: img.naturalHeight });
              if (img.naturalWidth) setFitted(Math.min(1, img.clientWidth / img.naturalWidth));
            }}
            onError={() => setFailed(true)}
            className={cn('rounded-md shadow-(--shadow-pill)', zoom === null ? 'max-h-full max-w-full object-contain' : 'max-w-none')}
            style={zoom !== null && size ? { width: size.w * zoom, height: size.h * zoom } : undefined}
          />
        )}
      </div>
    </div>
  );
}

function PdfView({ file }: { file: FileInfo }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className={BAR}><span>PDF · {formatSize(file.size)}</span></div>
      <iframe
        title={file.name}
        src={`${fileUrl(file.path)}&v=${encodeURIComponent(file.modifiedAt)}`}
        className="min-h-(--size-media-stage) w-full flex-1 rounded-xl border border-border bg-card"
      />
    </div>
  );
}

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="chat-pane max-w-(--container-measure) break-words text-foreground">
      <Streamdown mode="static" rehypePlugins={replyRehypePlugins}>{text}</Streamdown>
    </div>
  );
});

function MarkdownView({ file }: { file: FileInfo }) {
  const text = useFileText(file);
  const [source, setSource] = useState(false);
  if (file.size > MAX_TEXT_BYTES) return <TooLarge file={file} />;
  if (text.data === undefined) return <TextState query={text} />;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className={BAR}>
        <span>Markdown</span>
        <span className="flex-1" />
        <span role="tablist" aria-label="Show as" className={cn(TRACK, 'bg-muted')}>
          <button type="button" role="tab" aria-selected={!source} onClick={() => setSource(false)} className={TAB}>Preview</button>
          <button type="button" role="tab" aria-selected={source} onClick={() => setSource(true)} className={TAB}>Source</button>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {source
          ? <pre className="m-0 rounded-xl border border-border bg-card p-3 font-code text-ui whitespace-pre-wrap break-words">{text.data}</pre>
          : <Markdown text={text.data} />}
      </div>
    </div>
  );
}

/** The viewer for a file's kind; keyed by path, so flipping files starts each one fresh. */
export function MediaView({ file }: { file: FileInfo }) {
  switch (file.kind) {
    case 'csv': return <CsvView key={file.path} file={file} />;
    case 'image': return <ImageView key={file.path} file={file} />;
    case 'pdf': return <PdfView key={file.path} file={file} />;
    case 'markdown': return <MarkdownView key={file.path} file={file} />;
    default: return <Note>This kind of file can't be shown here.</Note>;
  }
}
