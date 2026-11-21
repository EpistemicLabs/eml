// The strip under the header that every banner renders through (update,
// brain hygiene): one layout, and a tone that says the state, not the sender —
// info: something is up to you (amber), success: done (grey, the only one
// with ×), destructive: broken (red). Tokens v2: colour only for meaning.
import type { ReactNode } from 'react';
import { Loader2, X, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { FIELD, FOCUS, HUE, PRIMARY } from '@/shared/view/ui';

export type BannerTone = 'info' | 'success' | 'destructive';

const TONE: Record<BannerTone, string> = {
  info: cn(HUE.you.edge, HUE.you.tint),
  success: 'border-border bg-card',
  destructive: cn(HUE.stopped.edge, HUE.stopped.tint),
};
const INK: Record<BannerTone, string> = { info: HUE.you.ink, success: 'text-foreground', destructive: HUE.stopped.ink };

/** A field inside a banner's form (a handle, an invite link). */
export const BANNER_FIELD = cn(FIELD, 'min-h-(--target-min) w-auto px-2 text-ui');

export function Banner({
  tone,
  icon: Icon,
  busy = false,
  detail,
  actions,
  onDismiss,
  below,
  children,
}: {
  tone: BannerTone;
  icon: LucideIcon;
  /** A spinner in place of the icon while an action runs. */
  busy?: boolean;
  /** A second, smaller line under the message (a reason, an error). */
  detail?: ReactNode;
  /** Buttons and links on the right, in the same row. */
  actions?: ReactNode;
  /** Only for success: the user has seen it. Everything else stays until done. */
  onDismiss?: () => void;
  /** Full-width content under the row (an opened report). */
  below?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div data-ui="v2" role={tone === 'destructive' ? 'alert' : 'status'} className={cn('mx-2 mt-2 flex-shrink-0 rounded-xl border px-3 py-2 text-body text-foreground', TONE[tone])}>
      <div className="flex items-center gap-2.5">
        {busy
          ? <Loader2 aria-hidden className={cn('size-4 flex-shrink-0 animate-spin', INK[tone])} />
          : <Icon aria-hidden className={cn('size-4 flex-shrink-0', INK[tone])} />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{children}</div>
          {detail && <div className="mt-0.5 break-words font-code text-ui text-muted-foreground">{detail}</div>}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-3">{actions}</div>}
        {onDismiss && (
          <button type="button" aria-label="Dismiss" title="Dismiss" className={cn('grid size-(--target-min) place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground', FOCUS)} onClick={onDismiss}>
            <X aria-hidden className="size-4" />
          </button>
        )}
      </div>
      {below}
    </div>
  );
}

/** The one main action of a banner: the filled primary button, at the small size. */
export function BannerButton({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" disabled={disabled} className={cn(PRIMARY, 'min-h-(--target-min) px-3 text-ui')} onClick={onClick}>
      {children}
    </button>
  );
}

/** A secondary action: a link-styled button, or a link when `href` is given. */
export function BannerLink({ href, icon: Icon, onClick, children }: { href?: string; icon?: LucideIcon; onClick?: () => void; children: ReactNode }) {
  const className = cn('inline-flex min-h-(--target-min) items-center gap-1 rounded-md text-ui font-medium text-foreground underline-offset-2 hover:underline', FOCUS);
  const content = <>{Icon && <Icon aria-hidden className="size-3" />}{children}</>;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>{content}</a>
  ) : (
    <button type="button" className={className} onClick={onClick}>{content}</button>
  );
}
