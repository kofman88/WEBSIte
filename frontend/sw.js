/* CHM Finance — service worker.
 *
 * Minimal: handles web-push "push" events + notification clicks. We
 * intentionally do NOT cache pages — the app is auth-gated and data-
 * heavy, serving stale shells is worse than a spinner.
 */

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_e) {}
  const title = data.title || 'CHM Finance';
  const body = data.body || '';
  const url = data.url || '/dashboard.html';
  const tag = data.tag || 'chm';
  event.waitUntil(self.registration.showNotification(title, {
    body, tag,
    icon: '/assets/img/icon-192.png',
    badge: '/assets/img/badge.png',
    data: { url },
    requireInteraction: false,
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/dashboard.html';
  event.waitUntil(clients.matchAll({ type: 'window' }).then((wins) => {
    for (const w of wins) {
      if (w.url.includes(self.location.origin)) { w.focus(); w.navigate(url); return; }
    }
    return clients.openWindow(url);
  }));
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
