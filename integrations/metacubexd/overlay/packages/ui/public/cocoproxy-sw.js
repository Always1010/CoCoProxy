/* Notification-only worker: no fetch handler, app-shell cache, or API cache. */
function database() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('cocoproxy-notifications', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('state');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}
async function remember(key, value) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('state', 'readwrite'), store = tx.objectStore('state');
      const get = store.get(key); let result;
      get.onsuccess = () => {
        if (key === 'disabled' && value === true) { store.clear(); store.put(true, key); result = true; return; }
        result = get.result;
        if (value !== undefined && (!result || typeof value !== 'object' || value.at >= result.at)) { result = value; store.put(value, key); }
        if (typeof value === 'object') {
          const count = store.count();
          count.onsuccess = () => {
            if (count.result <= 201) return;
            let remaining = count.result - 201;
            const cursor = store.openCursor();
            cursor.onsuccess = () => {
              const item = cursor.result;
              if (!item || remaining <= 0) return;
              if (item.key !== 'disabled' && item.key !== key) { item.delete(); remaining--; }
              item.continue();
            };
          };
        }
      };
      tx.oncomplete = () => resolve(result); tx.onerror = () => reject(tx.error);
    });
  } finally { db.close(); }
}
self.addEventListener('push', event => {
  event.waitUntil((async () => {
    if (Notification.permission !== 'granted' || await remember('disabled') === true) return;
    let payload;
    try { payload = event.data.json(); } catch { payload = {}; }
    if (!payload || typeof payload !== 'object' || !Number.isSafeInteger(payload.expiresAt) || payload.expiresAt <= Date.now()) return;
    const message = {
      title: typeof payload.title === 'string' ? payload.title.slice(0, 150) : 'CoCoProxy',
      body: typeof payload.body === 'string' ? payload.body.slice(0, 1000) : '后台状态有更新，请打开查看。',
      at: Number.isSafeInteger(payload.at) ? payload.at : Date.now(),
      tag: typeof payload.tag === 'string' && /^cocoproxy-[A-Za-z0-9_-]{1,40}$/.test(payload.tag) ? payload.tag : 'cocoproxy-status',
    };
    const latest = await remember(message.tag, message).catch(() => message);
    await self.registration.showNotification(latest.title, { body: latest.body, tag: latest.tag, renotify: false,
      icon: '/pwa-192x192.png', badge: '/pwa-192x192.png', timestamp: latest.at, data: { url: '/#/cocoproxy' } });
  })());
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL('/#/cocoproxy', self.location.origin).href;
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const page = pages.find(client => new URL(client.url).origin === self.location.origin);
    if (page) { await page.navigate(target); await page.focus(); }
    else await self.clients.openWindow(target);
  })());
});
self.addEventListener('message', event => {
  if (!event.source || new URL(event.source.url).origin !== self.location.origin) return;
  if (!['NOTIFICATIONS_ENABLED', 'NOTIFICATIONS_DISABLED'].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    const disabled = event.data.type === 'NOTIFICATIONS_DISABLED';
    await remember('disabled', disabled);
    if (disabled) {
      const subscription = await self.registration.pushManager.getSubscription();
      await subscription?.unsubscribe();
      const notifications = await self.registration.getNotifications(); notifications.forEach(item => item.close());
    }
  })());
});
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    if (Notification.permission !== 'granted' || await remember('disabled') === true) return;
    const key = event.oldSubscription?.options.applicationServerKey;
    if (!event.newSubscription && !key) return;
    const subscription = event.newSubscription ?? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await fetch('/api/cocoproxy/notifications/subscription', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ subscription: subscription.toJSON() }) });
  })().catch(() => {}));
});
