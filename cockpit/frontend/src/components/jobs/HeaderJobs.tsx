// The header's right side: the Jobs view's button and the bell. The bell holds
// what the cockpit told the user (host notifications.ts) — a scheduled run that
// needs them, a run that failed, a job that paused itself — kept on the host,
// so it is there when a tab opens later. A new one shows as a short toast while
// the cockpit is in front, and as a browser notification (Settings › Notifications)
// when it is not.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CalendarClock, X } from 'lucide-react';

import { api } from '@/utils/api';
import { cn } from '@/lib/utils';
import { readSettings } from '@/components/settings/utils/settingsStorage';
import { setTopView, useTopView } from '@/stores/useTopViewStore';
import { formatAgo, openSession, type CockpitNotification } from './jobs';

const KIND_LABEL: Record<CockpitNotification['kind'], string> = {
  review: 'Check this', question: 'Needs you', failed: 'Failed', done: 'Done', missed: 'Missed', paused: 'Paused',
};

const KIND_TONE: Record<CockpitNotification['kind'], string> = {
  review: 'text-warning', question: 'text-warning', failed: 'text-destructive', done: 'text-success', missed: 'text-muted-foreground', paused: 'text-destructive',
};

const TOAST_MS = 8000;

export default function HeaderJobs() {
  const topView = useTopView();
  const [items, setItems] = useState<CockpitNotification[]>([]);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<CockpitNotification | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const response = await api.notifications();
      if (response.ok) setItems((await response.json() as { items: CockpitNotification[] }).items);
    } catch { /* host gone: the next event reloads */ }
  }, []);

  useEffect(() => {
    void load();
    const onNotification = (event: Event) => {
      const item = (event as CustomEvent<CockpitNotification>).detail;
      void load();
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        setToast(item);
        return;
      }
      if (!readSettings().notifyOnDone || !('Notification' in window) || Notification.permission !== 'granted') return;
      try {
        new Notification(`${KIND_LABEL[item.kind]}: ${item.title}`, { body: item.body, tag: item.id });
      } catch { /* notifications unavailable */ }
    };
    window.addEventListener('cockpit:notification', onNotification);
    // A tab that comes back to the front catches up.
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('cockpit:notification', onNotification);
      window.removeEventListener('focus', onFocus);
    };
  }, [load]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // A click outside closes the list.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const unread = items.filter((item) => !item.read).length;

  const markRead = async (ids?: string[]) => {
    await api.readNotifications(ids).catch(() => undefined);
    void load();
  };

  const follow = (item: CockpitNotification) => {
    void markRead([item.id]);
    setOpen(false);
    setToast(null);
    if (item.sessionId) openSession(item.spaceId, item.sessionId, item.session);
    else setTopView('jobs');
  };

  return (
    <div ref={panelRef} className="relative flex flex-shrink-0 items-center gap-1 pr-3">
      <button
        type="button"
        onClick={() => setTopView(topView === 'jobs' ? 'desks' : 'jobs')}
        aria-pressed={topView === 'jobs'}
        title="Jobs: scheduled work"
        className={cn(
          'flex h-8 items-center gap-1.5 rounded-md px-2 text-body transition-colors',
          topView === 'jobs' ? 'space-tab-active text-foreground' : 'text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground',
        )}
      >
        <CalendarClock className="h-4 w-4" />
        Jobs
      </button>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label={unread ? `${unread} unread notification${unread === 1 ? '' : 's'}` : 'Notifications'}
        title="Notifications"
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-semibold leading-none text-primary-foreground tabular-nums">
            {unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-3 top-full z-50 mt-1 w-96 max-w-[calc(100vw-1.5rem)] rounded-lg border border-foreground/15 bg-background shadow-lg">
          <div className="flex items-center justify-between border-b border-foreground/10 px-3 py-2">
            <span className="text-sm font-medium">Notifications</span>
            {unread > 0 && (
              <button type="button" onClick={() => void markRead()} className="text-xs text-primary hover:underline">Mark all read</button>
            )}
          </div>
          <ul className="max-h-[60vh] overflow-y-auto">
            {items.length === 0 && <li className="px-3 py-4 text-sm text-muted-foreground">Nothing yet. Scheduled jobs that need you show up here.</li>}
            {items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => follow(item)}
                  className={cn('flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-foreground/[0.05]', !item.read && 'bg-primary/[0.06]')}
                >
                  <span className="flex w-full items-baseline gap-2 text-sm">
                    <span className={cn('font-medium', KIND_TONE[item.kind])}>{KIND_LABEL[item.kind]}</span>
                    <span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
                    <span className="flex-shrink-0 text-xs text-muted-foreground">{formatAgo(item.at)}</span>
                  </span>
                  <span className="line-clamp-2 text-xs text-muted-foreground">{item.body}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {toast && !open && (
        <div role="status" className="fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] items-start gap-2 rounded-lg border border-foreground/15 bg-background px-3 py-2 shadow-lg">
          <button type="button" onClick={() => follow(toast)} className="min-w-0 flex-1 text-left">
            <span className="block text-sm"><span className={cn('font-medium', KIND_TONE[toast.kind])}>{KIND_LABEL[toast.kind]}</span> {toast.title}</span>
            <span className="line-clamp-2 block text-xs text-muted-foreground">{toast.body}</span>
          </button>
          <button type="button" onClick={() => setToast(null)} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
