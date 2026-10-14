// Single owner of document.title: "(3) Project - EML Cockpit" — the unseen
// finished-session count first so it shows in a background tab, then the
// selected project.
import { useEffect } from 'react';

export function useDocumentTitle(projectName: string | null | undefined, unseenCount: number): void {
  useEffect(() => {
    let title = 'EML Cockpit';
    const name = projectName?.trim();
    if (name) title = `${name} - ${title}`;
    if (unseenCount > 0) title = `(${unseenCount}) ${title}`;
    document.title = title;
  }, [projectName, unseenCount]);
}
