// The strip under the header that every banner renders through (update,
// brain hygiene): one layout, and a tone that says the state, not the sender —
// info: something is up to you, success: done (the only one with ×),
// destructive: broken.
import type { ReactNode } from 'react';
import { Loader2, X, type LucideIcon } from 'lucide-react';

export type BannerTone = 'info' | 'success' | 'destructive';

const TONE: Record<BannerTone, string> = {
  info: 'border-info/30 bg-info/10 text-info',
  success: 'border-success/30 bg-success/10 text-success',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
};

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
    <div role={tone === 'destructive' ? 'alert' : 'status'} className={`flex-shrink-0 border-b px-3 py-2 text-[13px] ${TONE[tone]}`}>
      <div className="flex items-center gap-2.5">
        {busy ? <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" /> : <Icon className="h-4 w-4 flex-shrink-0" />}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{children}</div>
          {detail && <div className="mt-0.5 break-words font-mono text-xs opacity-90">{detail}</div>}
        </div>
        {actions && <div className="flex flex-shrink-0 items-center gap-3">{actions}</div>}
        {onDismiss && (
          <button type="button" aria-label="Dismiss" title="Dismiss" className="rounded p-0.5 hover:bg-foreground/10" onClick={onDismiss}>
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {below}
    </div>
  );
}

/** The one main action of a banner, filled in the banner's tone. */
export function BannerButton({ disabled, onClick, children }: { disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className="rounded-md bg-current px-2.5 py-1 text-xs font-medium hover:opacity-90 disabled:opacity-60"
      onClick={onClick}
    >
      <span className="text-background">{children}</span>
    </button>
  );
}

/** A secondary action: a link-styled button, or a link when `href` is given. */
export function BannerLink({ href, icon: Icon, onClick, children }: { href?: string; icon?: LucideIcon; onClick?: () => void; children: ReactNode }) {
  const className = 'inline-flex items-center gap-1 text-xs hover:underline';
  const content = <>{Icon && <Icon className="h-3 w-3" />}{children}</>;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className={className}>{content}</a>
  ) : (
    <button type="button" className={className} onClick={onClick}>{content}</button>
  );
}
