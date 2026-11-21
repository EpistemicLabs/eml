// The shortcut sheet (?): every shortcut from the one list, grouped.
import { Dialog, DialogContent, DialogTitle, FOCUS } from '@/shared/view/ui';

import { SHORTCUTS, setShortcutSheet, useShortcutSheet, type Shortcut } from './shortcuts';

const GROUPS: Array<Shortcut['group']> = ['Desks', 'Tasks', 'Everywhere'];

export function Keys({ keys }: { keys: string[] }) {
  return (
    <span className="flex items-center justify-end gap-1 text-caption text-muted-foreground">
      {keys.map((k, i) => (k === 'then'
        ? <span key={i}>then</span>
        : <kbd key={i} className="rounded-sm border border-b-2 border-border bg-card px-1 py-0.5 tabular-nums text-caption leading-none text-muted-foreground">{k}</kbd>))}
    </span>
  );
}

export function ShortcutSheet() {
  const open = useShortcutSheet();
  return (
    <Dialog open={open} onOpenChange={(o) => setShortcutSheet(o)}>
      <DialogContent data-ui="v2" className="glass-thick flex w-full max-w-dialog flex-col gap-1 rounded-3xl p-5 shadow-modal">
        <div className="flex items-center justify-between">
          <DialogTitle className="m-0 text-title font-semibold">Keyboard shortcuts</DialogTitle>
          <button type="button" aria-label="Close" onClick={() => setShortcutSheet(false)}
            className={`flex size-(--target-comfortable) items-center justify-center rounded-lg text-title text-muted-foreground hover:bg-muted hover:text-foreground ${FOCUS}`}>×</button>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2.5 text-body">
          {GROUPS.map((group) => [
            <span key={group} className="col-span-2 pt-2.5 text-caption font-semibold uppercase tracking-label text-muted-foreground">{group}</span>,
            ...SHORTCUTS.filter((s) => s.group === group).flatMap((s) => [
              <span key={`${s.label}-l`}>{s.label}</span>,
              <Keys key={`${s.label}-k`} keys={s.keys} />,
            ]),
          ])}
        </div>
      </DialogContent>
    </Dialog>
  );
}
