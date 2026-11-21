import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge only knows Tailwind's own font sizes. Our
// scale from index.css (text-caption … text-display) must be registered
// as font sizes, or it reads them as text colours and drops one of
// `text-caption text-foreground` as a conflict.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'ui', 'body', 'heading', 'chat', 'title', 'display'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
