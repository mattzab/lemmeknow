import type { Message, Priority, PushPayload } from "@shared/types";
import type { Env } from "./env";
import { getSubscriptions, getVapidKeys, insertMessage, pruneExpired, removeSubscriptions, type StoredSub } from "./store";
import { isValidTopic, normalizeBaseUrl, nowSec, randomString, utf8 } from "./util";
import { type PushResult, sendPush, type Urgency } from "./webpush";

export const retentionSeconds = (env: Env) => {
	const n = Number(env.RETENTION_SECONDS);
	return Number.isFinite(n) && n > 0 ? n : 7 * 86400;
};

/** The public base URL of this deployment; falls back to the request origin. */
export const baseUrlFor = (env: Env, req?: Request) => normalizeBaseUrl(env.BASE_URL || (req ? new URL(req.url).origin : ""));

/** VAPID `sub` claim. Apple requires a mailto: or https: URL. */
export const vapidSubject = (env: Env, req?: Request) => env.VAPID_SUBJECT || baseUrlFor(env, req) || "https://example.com";

export class InputError extends Error {
	constructor(
		message: string,
		readonly field?: string,
	) {
		super(message);
	}
}

export interface PublishInput {
	title?: unknown;
	body?: unknown;
	url?: unknown;
	priority?: unknown;
	tags?: unknown;
}

const LIMITS = { title: 200, body: 4000, url: 2000, tags: 10, tag: 40 };

/** Validate a publish request into a Message (throws InputError with the offending field). */
export function buildMessage(topic: string, input: PublishInput, now: number, retention: number): Message {
	if (!isValidTopic(topic)) throw new InputError("Topic names are 1-64 letters, digits, - or _.", "topic");
	const str = (v: unknown, field: string, max: number): string | undefined => {
		if (v === undefined || v === null || v === "") return undefined;
		if (typeof v !== "string") throw new InputError(`${field} must be a string.`, field);
		const t = v.trim();
		if (t.length > max) throw new InputError(`${field} is limited to ${max} characters.`, field);
		return t || undefined;
	};
	const title = str(input.title, "title", LIMITS.title);
	const body = str(input.body, "body", LIMITS.body);
	if (!body && !title) throw new InputError("Send a body (the notification text).", "body");
	const url = str(input.url, "url", LIMITS.url);
	if (url) {
		let u: URL;
		try {
			u = new URL(url);
		} catch {
			throw new InputError("url must be an absolute http(s) URL.", "url");
		}
		if (u.protocol !== "https:" && u.protocol !== "http:") throw new InputError("url must be an absolute http(s) URL.", "url");
	}
	let priority: Priority = 3;
	if (input.priority !== undefined && input.priority !== null && input.priority !== "") {
		const p = Number(input.priority);
		if (!Number.isInteger(p) || p < 1 || p > 5) throw new InputError("priority is 1 (min) to 5 (urgent).", "priority");
		priority = p as Priority;
	}
	let tags: string[] | undefined;
	if (input.tags !== undefined && input.tags !== null && input.tags !== "") {
		const raw = typeof input.tags === "string" ? input.tags.split(",") : Array.isArray(input.tags) ? input.tags : null;
		if (!raw || raw.some((t) => typeof t !== "string")) throw new InputError("tags is a list of strings (or a comma-separated string).", "tags");
		tags = (raw as string[]).map((t) => t.trim()).filter(Boolean);
		if (tags.length > LIMITS.tags || tags.some((t) => t.length > LIMITS.tag)) throw new InputError(`Up to ${LIMITS.tags} tags of ${LIMITS.tag} characters.`, "tags");
		if (!tags.length) tags = undefined;
	}
	return { id: randomString(14), topic, time: now, expires: now + retention, title, body: body ?? "", url, priority, tags };
}

const URGENCY: Record<Priority, Urgency> = { 1: "very-low", 2: "low", 3: "normal", 4: "high", 5: "high" };

/** Push payloads are capped at 4 KB by every push service; keep well under after encryption. */
const MAX_PAYLOAD = 3600;

export function pushPayload(m: Message): Uint8Array {
	const p: PushPayload = { id: m.id, topic: m.topic, time: m.time, title: m.title, body: m.body, url: m.url, priority: m.priority, tags: m.tags };
	let bytes = utf8(JSON.stringify(p));
	while (bytes.length > MAX_PAYLOAD && p.body.length) {
		p.body = `${p.body.slice(0, Math.max(0, p.body.length - Math.ceil((bytes.length - MAX_PAYLOAD) / 2) - 16))}…`;
		bytes = utf8(JSON.stringify(p));
	}
	return bytes;
}

type WaitUntil = (p: Promise<unknown>) => void;

export interface FanOutSummary {
	devices: number;
	sent: number;
	gone: number;
	failed: number;
}

/** Push one message to every device subscribed to its topic, then forget dead subscriptions. */
export async function fanOut(env: Env, m: Message, subject: string, subs?: StoredSub[]): Promise<FanOutSummary> {
	const list = subs ?? (await getSubscriptions(env.DB, m.topic));
	const summary: FanOutSummary = { devices: list.length, sent: 0, gone: 0, failed: 0 };
	if (!list.length) return summary;
	const keys = await getVapidKeys(env.DB);
	const payload = pushPayload(m);
	const ttl = Math.min(m.expires - m.time, 28 * 86400);
	const results: PushResult[] = await Promise.all(list.map((s) => sendPush(keys, s, payload, { ttl, urgency: URGENCY[m.priority], subject })));
	const gone: string[] = [];
	for (const r of results) {
		summary[r.outcome === "sent" ? "sent" : r.outcome === "gone" ? "gone" : "failed"]++;
		if (r.outcome === "gone") gone.push(r.endpoint);
		if (r.outcome === "failed") {
			console.warn(JSON.stringify({ event: "push_failed", topic: m.topic, host: new URL(r.endpoint).host, status: r.status, reason: r.reason }));
		}
	}
	if (gone.length) await removeSubscriptions(env.DB, m.topic, gone);
	console.log(JSON.stringify({ event: "push_fanout", topic: m.topic, message: m.id, ...summary }));
	return summary;
}

/**
 * Store a message and push it in the background. Returns how many devices will be notified.
 * The push itself runs under `waitUntil` so publishers get an immediate response.
 */
export async function publish(env: Env, waitUntil: WaitUntil, m: Message, subject: string): Promise<{ devices: number }> {
	const [, subs] = await Promise.all([insertMessage(env.DB, m, m.time), getSubscriptions(env.DB, m.topic)]);
	if (subs.length) {
		waitUntil(
			fanOut(env, m, subject, subs).catch((e) => console.error(JSON.stringify({ event: "push_fanout_error", topic: m.topic, error: (e as Error).message }))),
		);
	}
	return { devices: subs.length };
}

/** Cron: drop expired inbox rows. */
export async function runScheduled(env: Env): Promise<{ pruned: number }> {
	return { pruned: await pruneExpired(env.DB, nowSec()) };
}
