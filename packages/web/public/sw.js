/* Haive notification service worker.
 *
 * Owns OS-notification display and click routing. A page-scoped `new
 * Notification()` click is handled only by the tab that built it, and that tab
 * is elected by an arbitrary cross-tab race — so clicks landed on the wrong
 * tab (and `window.focus()` cannot raise a different tab). This shared worker
 * routes the click instead: focus the tab already showing the task, else open
 * a new one. No build step — plain JS served from /public at the origin root. */

self.addEventListener('install', () => {
  // Activate promptly so the click handler is live for the current session.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

/* Ask one window client for its LIVE route and resolve to its pathname.
 *
 * Why ask instead of reading `client.url`: WindowClient.url reflects only the
 * document's last NETWORK navigation, never a client-side (Next App Router
 * pushState) navigation. A tab that loaded at /tasks/new and pushed to
 * /tasks/<id> therefore still reports /tasks/new here, so a URL match would
 * miss it and we would open a duplicate tab. The page itself knows its real
 * route (location.pathname), so we ask it. Clients that are not a Haive app
 * page (e.g. /login) or have not mounted the listener yet simply time out and
 * are skipped. */
function askRoute(client) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 400);
    ch.port1.onmessage = (e) => {
      clearTimeout(timer);
      resolve((e.data && e.data.path) || null);
    };
    try {
      client.postMessage({ type: 'query-route' }, [ch.port2]);
    } catch {
      clearTimeout(timer);
      resolve(null);
    }
  });
}

async function findClientOnRoute(url) {
  const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // Primary: the live route each client reports (survives SPA pushState).
  const routes = await Promise.all(tabs.map((c) => askRoute(c)));
  const live = tabs.find((_, i) => routes[i] === url);
  if (live) return live;
  // Fallback: the static load URL, for any client that did not answer.
  return (
    tabs.find((c) => {
      try {
        return new URL(c.url).pathname === url;
      } catch {
        return false;
      }
    }) || null
  );
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  if (!url) return;
  event.waitUntil(
    (async () => {
      const hit = await findClientOnRoute(url);
      if (hit) {
        await hit.focus();
        return;
      }
      await self.clients.openWindow(url);
    })(),
  );
});
