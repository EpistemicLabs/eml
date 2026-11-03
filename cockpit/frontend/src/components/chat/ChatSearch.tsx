// Search through the whole conversation, folded rows included: going to a match opens
// what it is folded in. Matches are marked with the CSS Highlight API, so the
// rendered messages stay as they are; without it the current item's outline remains.
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';

import { keysToReveal, searchItems, type ChatItem } from './chat-state';
import { pasteTextDirectly } from './pasteText';

const HIGHLIGHT = 'chat-search';

function markMatches(log: Element, query: string): void {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const Highlight = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !Highlight) return;
  registry.delete(HIGHLIGHT);
  const needle = query.trim().toLowerCase();
  if (!needle) return;
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(log, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) {
      const range = new Range();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  registry.set(HIGHLIGHT, new Highlight(...ranges));
}

function clearMarks(root: Element | null): void {
  (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete(HIGHLIGHT);
  root?.querySelector('[data-chat-current]')?.removeAttribute('data-chat-current');
}

export function ChatSearch({
  items, opened, root, onReveal, onUnpin, onClose,
}: {
  items: ChatItem[];
  opened: Set<string>;
  root: RefObject<HTMLElement | null>;
  onReveal: (keys: string[]) => void;
  onUnpin: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [position, setPosition] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => searchItems(items, query), [items, query]);
  const current = matches.length > 0 ? Math.min(position, matches.length - 1) : -1;
  const currentId = current >= 0 ? matches[current] : null;

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const element = root.current;
    return () => clearMarks(element);
  }, [root]);

  useEffect(() => { setPosition(0); }, [query]);

  // Going to a match: open it, then scroll once it is on the page.
  useEffect(() => {
    if (!currentId) { root.current?.querySelector('[data-chat-current]')?.removeAttribute('data-chat-current'); return undefined; }
    onReveal(keysToReveal(items, currentId));
    const frame = requestAnimationFrame(() => {
      const element = root.current?.querySelector(`[data-chat-item="${CSS.escape(currentId)}"]`);
      root.current?.querySelector('[data-chat-current]')?.removeAttribute('data-chat-current');
      if (!element) return;
      element.setAttribute('data-chat-current', '');
      onUnpin();
      element.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
    // Only a new match moves the view; new events during a turn must not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId]);

  // Marks follow what is on the page: what opens, closes or streams in.
  useEffect(() => {
    const log = root.current?.querySelector('[role="log"]');
    if (!log) return undefined;
    const frame = requestAnimationFrame(() => markMatches(log, query));
    return () => cancelAnimationFrame(frame);
  }, [root, query, items, opened]);

  const step = (by: 1 | -1) => {
    if (matches.length > 0) setPosition((current + by + matches.length) % matches.length);
  };
  const button = 'rounded p-1 text-muted-foreground hover:bg-foreground/5 disabled:opacity-40';
  return (
    <div role="search" className="flex items-center gap-1 rounded-lg border border-border bg-card px-2 py-1">
      <input
        ref={input}
        type="text"
        aria-label="Search the conversation"
        placeholder="Search the conversation"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onPaste={pasteTextDirectly}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
          // Marked as handled: this Esc closes the search, it doesn't stop the turn.
          else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
        }}
        className="min-w-0 flex-1 bg-transparent outline-none"
      />
      <span role="status" className="flex-shrink-0 text-muted-foreground">
        {query.trim() ? `${current + 1} of ${matches.length}` : ''}
      </span>
      <button type="button" aria-label="Previous match" disabled={matches.length === 0} onClick={() => step(-1)} className={button}><ChevronUp className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label="Next match" disabled={matches.length === 0} onClick={() => step(1)} className={button}><ChevronDown className="h-3.5 w-3.5" /></button>
      <button type="button" aria-label="Close search" onClick={onClose} className={button}><X className="h-3.5 w-3.5" /></button>
    </div>
  );
}
