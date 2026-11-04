import { clsx, type ClassValue } from 'clsx'
import { extendTailwindMerge } from 'tailwind-merge'

// tailwind-merge only knows Tailwind's own font sizes (text-xs …). Our
// scale from index.css (text-caption/-ui/-body/-heading) must be registered
// as font sizes, or it reads them as text colours and drops one of
// `text-caption text-foreground` as a conflict.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['caption', 'ui', 'body', 'heading'] }],
    },
  },
})

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
