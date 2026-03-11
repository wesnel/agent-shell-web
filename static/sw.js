'use strict';

const CACHE_NAME = 'agent-shell-web-v1';
const STATIC_ASSETS = [
  '/',
  '/static/index.html',
  '/static/style.css',
  '/static/app.js',
  '/static/manifest.json',
  '/static/icon-192.svg',
  '/static/icon-512.svg',
];

// Track which tool-call-ids we've already notified about
const notifiedToolCalls = new Set();

// Poll interval in ms
const POLL_INTERVAL = 10000;

let pollTimerId = null;

// === Cache Management ===

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
  startPolling();
});

// === Fetch Handler (Network-First for API, Cache-First for Static) ===

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests: always go to network
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);

      return cached || networkFetch;
    })
  );
});

// === Notification Click ===

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Focus existing window if available
      for (const client of clients) {
        if (client.url.includes(self.registration.scope)) {
          client.navigate(url);
          return client.focus();
        }
      }
      // Open new window
      return self.clients.openWindow(url);
    })
  );
});

// === Polling for Stuck Sessions ===

function startPolling() {
  if (pollTimerId) return;
  pollTimerId = setInterval(checkForStuckSessions, POLL_INTERVAL);
  // Also check immediately
  checkForStuckSessions();
}

async function checkForStuckSessions() {
  // Only notify if permission granted
  if (Notification.permission !== 'granted') return;

  try {
    const response = await fetch('/api/status');
    if (!response.ok) return;
    const data = await response.json();

    if (!data.sessions) return;

    // Fetch details for stuck sessions (only once each)
    const allPendingIds = new Set();

    for (const session of data.sessions) {
      if (session.stuck && session.pending_permission_count > 0) {
        try {
          const detailResponse = await fetch(
            '/api/sessions/' + encodeURIComponent(session.buffer_name)
          );
          if (!detailResponse.ok) continue;
          const detail = await detailResponse.json();

          for (const perm of detail.pending_permissions || []) {
            const notifId = session.buffer_name + ':' + perm.tool_call_id;
            allPendingIds.add(notifId);

            if (notifiedToolCalls.has(notifId)) continue;
            notifiedToolCalls.add(notifId);

            const shortName = session.buffer_name.replace(/^\*|\*$/g, '');

            self.registration.showNotification('Permission Required', {
              body: `${shortName}: ${perm.title}`,
              icon: '/static/icon-192.svg',
              badge: '/static/icon-192.svg',
              tag: notifId,
              requireInteraction: true,
              data: {
                url: '/#/session/' + encodeURIComponent(session.buffer_name),
              },
            });
          }
        } catch (_) {}
      }
    }

    // Clean up notified set: remove tool-call-ids that are no longer pending
    for (const id of notifiedToolCalls) {
      if (!allPendingIds.has(id)) {
        notifiedToolCalls.delete(id);
      }
    }
  } catch (_) {
    // Server unreachable, silently ignore
  }
}

// === Message Handler (keep-alive from main page) ===

self.addEventListener('message', (event) => {
  if (event.data === 'keepalive') {
    // Just acknowledging to keep the SW alive
  }
  if (event.data === 'check-now') {
    checkForStuckSessions();
  }
});
