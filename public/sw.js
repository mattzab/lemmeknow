/* Lemmeknow service worker: shows Web Push notifications and opens their links.
 * Plain JS on purpose (served as-is, never bundled) so its URL and scope stay stable. */

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
	let msg = {};
	try {
		msg = event.data ? event.data.json() : {};
	} catch {
		msg = { body: event.data ? event.data.text() : "" };
	}
	const title = msg.title || msg.topic || "Lemmeknow";
	const body = msg.title ? msg.body || "" : msg.body || "New notification";
	// iOS revokes push permission from apps that receive a push without showing a notification,
	// so always show one, even when the app is open.
	event.waitUntil(
		(async () => {
			await self.registration.showNotification(title, {
				body,
				tag: msg.id || undefined,
				icon: "/icons/icon-192.png",
				badge: "/icons/badge-96.png",
				timestamp: msg.time ? msg.time * 1000 : Date.now(),
				requireInteraction: msg.priority === 5,
				silent: msg.priority === 1,
				data: { url: msg.url || null, topic: msg.topic || null, id: msg.id || null },
			});
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			for (const w of windows) w.postMessage({ type: "lemmeknow:message", message: msg });
		})(),
	);
});

self.addEventListener("notificationclick", (event) => {
	event.notification.close();
	const data = event.notification.data || {};
	const target = data.url || "/";
	event.waitUntil(
		(async () => {
			const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
			if (!data.url) {
				for (const w of windows) {
					if (new URL(w.url).origin === self.location.origin && "focus" in w) {
						w.postMessage({ type: "lemmeknow:refresh" });
						return w.focus();
					}
				}
			}
			return self.clients.openWindow(target);
		})(),
	);
});

// The browser rotated the subscription: the app re-registers it on next launch
// (it compares its stored endpoint with the live one), since tokens live in the page.
self.addEventListener("pushsubscriptionchange", () => {});
