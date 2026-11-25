// File paths in a reply's text, clickable (Lasse 2026-11-25): each path that names a file the viewer
// shows becomes a span the chat opens in the slide-over, in prose and in inline code alike. The
// chips under the reply stay. A rehype step after the sanitizer, so the span it adds is its own.

type HastNode = { type: string; tagName?: string; properties?: Record<string, unknown>; children?: HastNode[]; value?: string };

/** The attribute a clickable path carries: the path as the reply names it. */
export const FILE_REF_ATTR = 'data-file-ref';

/** Splits a text into plain pieces and the refs it holds, longest ref first where two overlap. */
export function splitByRefs(value: string, refs: string[]): Array<{ text: string; ref?: string }> {
  const ordered = [...refs].filter(Boolean).sort((a, b) => b.length - a.length);
  const parts: Array<{ text: string; ref?: string }> = [];
  let rest = value;
  while (rest) {
    let best: { at: number; ref: string } | null = null;
    for (const ref of ordered) {
      const at = rest.indexOf(ref);
      if (at !== -1 && (!best || at < best.at)) best = { at, ref };
    }
    if (!best) { parts.push({ text: rest }); break; }
    if (best.at > 0) parts.push({ text: rest.slice(0, best.at) });
    parts.push({ text: best.ref, ref: best.ref });
    rest = rest.slice(best.at + best.ref.length);
  }
  return parts;
}

/** A rehype plugin that wraps every occurrence of `refs` in a clickable span; links and code blocks stay as they are. */
export function rehypeFileRefs(refs: string[]) {
  return () => (tree: HastNode) => {
    if (refs.length === 0) return;
    const visit = (node: HastNode) => {
      if (!node.children) return;
      // A link already goes somewhere, and a code block is copied as it is.
      if (node.type === 'element' && (node.tagName === 'a' || node.tagName === 'pre')) return;
      node.children = node.children.flatMap((child): HastNode[] => {
        if (child.type !== 'text' || !child.value) { visit(child); return [child]; }
        const parts = splitByRefs(child.value, refs);
        if (parts.length === 1 && !parts[0].ref) return [child];
        return parts.map((part) => (part.ref
          ? { type: 'element', tagName: 'span', properties: { dataFileRef: part.ref, role: 'button', tabIndex: 0, className: ['file-ref'], title: 'Open this file' }, children: [{ type: 'text', value: part.text }] }
          : { type: 'text', value: part.text }));
      });
    };
    visit(tree);
  };
}
