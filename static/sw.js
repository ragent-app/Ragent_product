'use strict';

const IMMUTABLE_CACHE_NAME = 'ragent-immutable-v1';

function resolveScopeUrl(pathname) {
  return new URL(pathname, self.registration.scope).toString();
}

async function clearLegacyCaches({ includeImmutable = false } = {}) {
  const cacheNames = await self.caches.keys();
  await Promise.all(
    cacheNames
      .filter((cacheName) => includeImmutable || cacheName !== IMMUTABLE_CACHE_NAME)
      .map((cacheName) => self.caches.delete(cacheName)),
  );
}

function isCacheableImmutableAssetRequest(request) {
  if (!request || request.method !== 'GET') return false;
  if (request.headers.has('range')) return false;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname.startsWith('/api/') || url.pathname.endsWith('/sw.js') || url.pathname === '/sw.js') return false;
  if (!url.searchParams.has('v')) return false;
  return /\.(?:js|mjs|css|woff2?|svg|png|webp|ico)$/i.test(url.pathname);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(clearLegacyCaches({ includeImmutable: false }));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    await clearLegacyCaches({ includeImmutable: false });
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.disable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'ragent:clear-caches') return;
  event.waitUntil(clearLegacyCaches({ includeImmutable: true }));
});

self.addEventListener('fetch', (event) => {
  if (!isCacheableImmutableAssetRequest(event.request)) return;
  event.respondWith((async () => {
    try {
      const cache = await self.caches.open(IMMUTABLE_CACHE_NAME);
      const cached = await cache.match(event.request);
      if (cached) return cached;
      const response = await fetch(event.request);
      if (response && response.ok && response.type === 'basic') {
        cache.put(event.request, response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return fetch(event.request);
    }
  })());
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
        tag: responsibilityId && responsibilityEventId ? `responsibility-${responsibilityEventId}` : 'ragent-done',
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
          type: 'ragent:open-session',
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
