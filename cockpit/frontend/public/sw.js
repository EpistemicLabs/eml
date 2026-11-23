// The cockpit's service worker: shows the host's push messages and opens the
// session a tap names. It caches nothing and handles no fetch, so the page
// always comes fresh from the host.
//
// A message is in the Declarative Web Push format (host domain/push-notice.ts):
// { web_push: 8030, notification: { title, body, tag, navigate } }.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let notification = {};
  try {
    notification = event.data ? event.data.json().notification ?? {} : {};
  } catch {
    // Not ours to read: still show something, a push without a notification costs the subscription.
  }
  event.waitUntil(self.registration.showNotification(notification.title || 'EML Cockpit', {
    body: notification.body || '',
    tag: notification.tag || 'cockpit',
    icon: '/icon-192.png',
    data: { navigate: notification.navigate || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.navigate || '/', self.location.origin);
  const sessionId = target.searchParams.get('session');
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === target.origin);
    if (open) {
      // The cockpit is already open: it opens the session itself, without a reload.
      if (sessionId) open.postMessage({ type: 'open-session', sessionId });
      return open.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});
