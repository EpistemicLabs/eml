import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge only knows Tailwind's own font sizes. Our
// scale from index.css (text-caption … text-display) must be registered
// as font sizes, or it reads them as text colours and drops one of
// `text-caption text-foreground` as a conflict.
// The same for the container widths and shadows index.css adds (max-w-dialog, shadow-modal …):
// unknown to it, they would sit next to a max-w-4xl or shadow-overlay instead of giving way.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      container: ['dialog', 'sheet', 'task-pane', 'board-col', 'board-col-slim', 'plan-table', 'measure', 'content'],
      shadow: ['card', 'raised', 'glass', 'overlay', 'modal', 'sheet'],
    },
    classGroups: {
      'font-size': [{ text: ['caption', 'ui', 'body', 'heading', 'chat', 'title', 'display'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
