// Browser side of Lemmeknow: local storage of topics + tokens, the service worker, and the
// Web Push subscription. Everything talks only to this deployment's own /api/v1.
import type { MeInfo, Message, PushSubscriptionJSON } from "@shared/types";

export interface SavedTopic {
	topic: string;
	/** Bearer token for this topic ("" for public topics). Stays on this device. */
	token: string;
	/** Whether this device is registered for Web Push on the topic. */
	push: boolean;
}

interface Saved {
	topics: SavedTopic[];
	/** The push endpoint last registered with the server, to detect browser-side rotation. */
	endpoint?: string;
}

const KEY = "lemmeknow.v1";

export function loadSaved(): Saved {
	try {
		const s = JSON.parse(localStorage.getItem(KEY) ?? "") as Saved;
		return { topics: Array.isArray(s.topics) ? s.topics : [], endpoint: s.endpoint };
	} catch {
		return { topics: [] };
	}
}

export function storeSaved(s: Saved) {
	localStorage.setItem(KEY, JSON.stringify(s));
}

/** The signed-in person on this device (from the Access session, or paired with a code from Safari). */
const ACCOUNT = "lemmeknow.account";
export function loadAccount(): MeInfo | null {
	try {
		const a = JSON.parse(localStorage.getItem(ACCOUNT) ?? "") as MeInfo;
		return a?.email && a.token ? a : null;
	} catch {
		return null;
	}
}
export function storeAccount(a: MeInfo | null) {
	if (a) localStorage.setItem(ACCOUNT, JSON.stringify(a));
	else localStorage.removeItem(ACCOUNT);
}

/**
 * /api/me rides on the Cloudflare Access cookie. Without one, Access answers with a redirect to
 * its login page (opaque with redirect: "manual"): that means "not signed in here", not an error.
 */
export async function sessionMe(): Promise<MeInfo | "signed-out" | "not-invited"> {
	const res = await fetch("/api/me", { credentials: "same-origin", redirect: "manual", headers: { accept: "application/json" } });
	if (res.type === "opaqueredirect" || res.status === 401 || res.status === 0) return "signed-out";
	if (res.status === 403) return "not-invited";
	if (!res.ok || !(res.headers.get("content-type") ?? "").includes("json")) return "signed-out";
	return (await res.json()) as MeInfo;
}

const ua = () => navigator.userAgent;
export const isIOS = () => /iPhone|iPad|iPod/.test(ua()) || (ua().includes("Macintosh") && navigator.maxTouchPoints > 1);
export const isAndroid = () => /Android/.test(ua());
export const isStandalone = () =>
	window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
export const permission = (): NotificationPermission | "unsupported" => ("Notification" in window ? Notification.permission : "unsupported");

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
	const headers = new Headers(init.headers);
	if (init.token) headers.set("authorization", `Bearer ${init.token}`);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	const res = await fetch(path, { ...init, headers });
	const data = (await res.json().catch(() => ({}))) as { error?: string };
	if (!res.ok) throw new ApiError(data.error || `HTTP ${res.status}`, res.status);
	return data as T;
}

const enc = (t: string) => encodeURIComponent(t);

export const api = {
	key: () => call<{ public_key: string }>("/api/v1/push/key").then((r) => r.public_key),
	messages: (t: SavedTopic, limit = 50) => call<{ messages: Message[] }>(`/api/v1/topics/${enc(t.topic)}/messages?limit=${limit}`, { token: t.token }).then((r) => r.messages),
	subscribe: (t: SavedTopic, subscription: PushSubscriptionJSON) =>
		call<{ id: string }>(`/api/v1/topics/${enc(t.topic)}/subscriptions`, { method: "POST", token: t.token, body: JSON.stringify({ subscription }) }),
	unsubscribe: (topic: string, endpoint: string) => call<{ removed: number }>(`/api/v1/topics/${enc(topic)}/subscriptions`, { method: "DELETE", body: JSON.stringify({ endpoint }) }),
	me: (token: string) => call<MeInfo>("/api/v1/me", { token }),
	pair: (code: string) => call<MeInfo>("/api/v1/pair", { method: "POST", body: JSON.stringify({ code }) }),
	pairCode: () => call<{ code: string; expires_at: number }>("/api/me/pair", { method: "POST", redirect: "manual" }),
	rotate: () => call<MeInfo>("/api/me/token/rotate", { method: "POST", redirect: "manual" }),
	publish: (t: SavedTopic, body: { title?: string; body: string }) =>
		call<{ devices: number }>(`/api/v1/topics/${enc(t.topic)}/messages`, { method: "POST", token: t.token, body: JSON.stringify(body) }),
};

export function registerServiceWorker(): Promise<ServiceWorkerRegistration> | null {
	if (!("serviceWorker" in navigator)) return null;
	return navigator.serviceWorker.register("/sw.js", { scope: "/" });
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

const sameKey = (a: ArrayBuffer | null | undefined, b: Uint8Array) => !!a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);

/** This device's push subscription for `vapidKey`, creating (or re-creating) it as needed. */
export async function ensurePushSubscription(vapidKey: string): Promise<PushSubscriptionJSON> {
	const reg = await navigator.serviceWorker.ready;
	const key = b64urlToBytes(vapidKey);
	let sub = await reg.pushManager.getSubscription();
	if (sub && !sameKey(sub.options.applicationServerKey, key)) {
		await sub.unsubscribe();
		sub = null;
	}
	if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	return sub.toJSON() as PushSubscriptionJSON;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
	if (!pushSupported()) return null;
	const reg = await navigator.serviceWorker.getRegistration("/");
	return reg ? reg.pushManager.getSubscription() : null;
}
