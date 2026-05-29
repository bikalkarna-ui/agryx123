// AGRYX Service Worker — Push Notifications
self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const options = {
    body: data.body || 'You have a new notification from AGRYX',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Open AGRYX' },
      { action: 'close', title: 'Dismiss' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'AGRYX', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'close') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      for (const client of clients) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/');
    })
  );
});

// Background sync for deadline reminders
self.addEventListener('sync', function(event) {
  if (event.tag === 'deadline-check') {
    event.waitUntil(checkDeadlines());
  }
});

async function checkDeadlines() {
  // Will be triggered by the app
}
