// One file, read-only, in CodeMirror: line numbers, folding, search (⌘F /
// Ctrl+F), coloured like the diffs (repository.css). The editor is made once per
// file; its language follows when the grammar has loaded.
import { useEffect, useRef } from 'react';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view';
import { codeFolding, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { classHighlighter } from '@lezer/highlight';

import { useLanguage } from './highlight';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', backgroundColor: 'transparent', color: 'var(--color-foreground)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '18px' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'color-mix(in srgb, var(--color-muted-foreground) 70%, transparent)' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--color-foreground) 4%, transparent)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'color-mix(in srgb, var(--color-ring) 28%, transparent) !important',
  },
  '.cm-selectionMatch': { backgroundColor: 'color-mix(in srgb, var(--color-ring) 16%, transparent)' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--color-warning) 30%, transparent)' },
  '.cm-searchMatch-selected': { backgroundColor: 'color-mix(in srgb, var(--color-warning) 55%, transparent)' },
  '.cm-panels': { backgroundColor: 'var(--color-card)', color: 'var(--color-foreground)', borderColor: 'var(--color-border)' },
  '.cm-panel.cm-search': { fontSize: '12px', padding: '6px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
  '.cm-textfield': { backgroundColor: 'var(--color-background)', border: '1px solid var(--color-border)', borderRadius: '4px', color: 'inherit' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--color-muted)', border: '1px solid var(--color-border)', borderRadius: '4px', color: 'inherit' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--color-muted)', border: 'none', color: 'var(--color-muted-foreground)' },
});

export function CodeView({ content, fileName }: { content: string; fileName: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const language = useLanguage(fileName);

  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          EditorState.readOnly.of(true),
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          drawSelection(),
          codeFolding(),
          foldGutter(),
          search({ top: true }),
          highlightSelectionMatches(),
          keymap.of([...searchKeymap, ...foldKeymap]),
          syntaxHighlighting(classHighlighter),
          languageSlot.current.of([]),
          theme,
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [content]);

  useEffect(() => {
    view.current?.dispatch({ effects: languageSlot.current.reconfigure(language?.extension ?? []) });
  }, [language, content]);

  return <div ref={host} className="repo-code h-full min-h-0" />;
}
