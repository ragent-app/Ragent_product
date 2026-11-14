'use strict';

function resolveScopeUrl(pathname) {
  return new URL(pathname, self.registration.scope).toString();
}

async function clearLegacyCaches() {
  const cacheNames = await self.caches.keys();
  await Promise.all(cacheNames
    .map((cacheName) => self.caches.delete(cacheName)));
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(clearLegacyCaches());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearLegacyCaches();
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'agentoc:clear-caches') return;
  event.waitUntil(clearLegacyCaches());
});

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch {}
  const safeId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : '';
  const responsibilityId = data.kind === 'responsibility' ? safeId(data.responsibilityId) : '';
  const sessionId = responsibilityId ? safeId(data.sessionId) : (data.sessionId || null);
  const responsibilityEventId = typeof data.eventId === 'string' ? safeId(data.eventId.replaceAll(':','_')) : '';
  const params = new URLSearchParams({ tab:'sessions', session:sessionId || '', responsibility:responsibilityId });
  const target = {
    sessionId,
    tab: data.kind === 'responsibility' ? 'sessions' : (data.tab || 'sessions'),
    responsibilityId,
    url: data.kind === 'responsibility' ? (responsibilityId && sessionId ? resolveScopeUrl(`?${params}`) : resolveScopeUrl('./')) : (data.url || '/'),
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // Skip notification if app window is currently visible
      for (const client of clientList) {
        if (client.visibilityState === 'visible') return;
      }
      return self.registration.showNotification(data.title || 'Ragent', {
        body: data.body || 'Task completed',
        icon: resolveScopeUrl('icon.svg'),
        badge: resolveScopeUrl('notification-badge.png'),
        tag: responsibilityId && responsibilityEventId ? `responsibility-${responsibilityEventId}` : 'agentoc-done',
        renotify: true,
        data: target,
      });
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = {
    sessionId: event.notification.data?.sessionId || null,
    tab: event.notification.data?.tab || 'sessions',
    url: event.notification.data?.url || '/',
    responsibilityId: event.notification.data?.responsibilityId || '',
  };
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      const client = clientList[0];
      if (client) {
        client.postMessage({
          type: 'agentoc:open-session',
          sessionId: target.sessionId,
          tab: target.tab,
          url: target.url,
          responsibilityId: target.responsibilityId,
        });
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow(target.url);
    })
  );
});
