// Syntax colouring for the repository view: the language from the file name
// (@codemirror/language-data loads each grammar on first use), tokens as
// tok-* classes (classHighlighter), coloured in repository.css from the
// cockpit's palette — the diffs and the file view look the same.
import { useEffect, useState } from 'react';
import { LanguageDescription, type Language } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { classHighlighter, highlightCode } from '@lezer/highlight';

const loaded = new Map<string, Promise<Language | null>>();

function loadLanguage(fileName: string): Promise<Language | null> {
  const description = LanguageDescription.matchFilename(languages, fileName);
  if (!description) return Promise.resolve(null);
  let pending = loaded.get(description.name);
  if (!pending) {
    pending = description.load().then((support) => support.language, () => null);
    loaded.set(description.name, pending);
  }
  return pending;
}

/** The language of a file; null while it loads and for a file no grammar knows. */
export function useLanguage(fileName: string): Language | null {
  const [language, setLanguage] = useState<Language | null>(null);
  useEffect(() => {
    let live = true;
    setLanguage(null);
    void loadLanguage(fileName).then((lang) => { if (live) setLanguage(lang); });
    return () => { live = false; };
  }, [fileName]);
  return language;
}

export interface Token {
  text: string;
  /** tok-* classes; empty for plain text. */
  cls: string;
}

/** Text split into lines of coloured tokens; without a language, one plain token a line. */
export function highlightLines(text: string, language: Language | null): Token[][] {
  if (!language) return text.split('\n').map((line) => [{ text: line, cls: '' }]);
  const lines: Token[][] = [[]];
  highlightCode(
    text,
    language.parser.parse(text),
    classHighlighter,
    (part, cls) => lines[lines.length - 1].push({ text: part, cls }),
    () => lines.push([]),
  );
  return lines;
}
