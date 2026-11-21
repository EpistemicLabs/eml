import { cn } from '@/lib/utils';

/**
 * Letter tiles for a set of names: the first letter, or the first two where another name starts
 * with the same letter ("EML" → E, "Ebisu" → Eb), so every tile tells its name apart.
 */
export function monograms(names: readonly string[]): Map<string, string> {
  const first = (name: string) => (name.trim()[0] ?? '?').toUpperCase();
  const out = new Map<string, string>();
  for (const name of names) {
    const letter = first(name);
    const shared = names.filter((other) => first(other) === letter);
    const short = shared.length > 1 && shared.indexOf(name) > 0 ? letter + (name.trim()[1] ?? '').toLowerCase() : letter;
    out.set(name, short);
  }
  return out;
}

/** A space's letter tile: dark while it is the open space, grey otherwise. */
export function Monogram({ letters, active = false, className }: { letters: string; active?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-grid size-6 flex-shrink-0 place-items-center rounded-md text-caption font-bold',
        active ? 'bg-foreground text-background' : 'bg-foreground/8 text-foreground',
        className,
      )}
    >
      {letters}
    </span>
  );
}
