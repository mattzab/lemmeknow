import type { PushSubscriptionJSON } from "@shared/types";
import { Hono } from "hono";
import { AuthError, authorize } from "./auth";
import { type Env, VERSION } from "./env";
import { buildMessage, InputError, type PublishInput, publish, retentionSeconds, vapidSubject } from "./service";
import { addSubscription, getVapidKeys, listMessages, MAX_LIST, removeSubscriptions, TooManySubscriptions } from "./store";
import { isValidTopic, nowSec, sha256Hex } from "./util";
import { isAcceptableEndpoint } from "./webpush";

/**
 * Lemmeknow public API, mounted at /api/v1. Token auth (Bearer), never Cloudflare Access, so the
 * PWA, scripts and other tools can call it. Every error is `{ error, field? }`.
 *
 *   GET    /api/v1/health
 *   GET    /api/v1/push/key                              VAPID public key for PushManager.subscribe
 *   POST   /api/v1/topics/:topic/messages                publish (write)
 *   GET    /api/v1/topics/:topic/messages?since=&limit=  inbox, newest first (read)
 *   POST   /api/v1/topics/:topic/subscriptions           register this device for Web Push (read)
 *   DELETE /api/v1/topics/:topic/subscriptions           unregister (knowing the endpoint is enough)
 */
export const api = new Hono<{ Bindings: Env }>();

const MAX_BODY_BYTES = 16 * 1024;

api.use("*", async (c, next) => {
	await next();
	c.header("access-control-allow-origin", "*");
	c.header("cache-control", "no-store");
});

api.options("*", (c) =>
	c.body(null, 204, {
		"access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
		"access-control-allow-headers": "authorization, content-type",
		"access-control-max-age": "86400",
	}),
);

api.onError((e, c) => {
	if (e instanceof AuthError) return c.json({ error: e.message }, e.status);
	if (e instanceof InputError) return c.json({ error: e.message, ...(e.field ? { field: e.field } : {}) }, 400);
	if (e instanceof TooManySubscriptions) return c.json({ error: e.message }, 409);
	console.error(JSON.stringify({ event: "api_error", path: c.req.path, error: (e as Error).message }));
	return c.json({ error: "Internal error" }, 500);
});

api.get("/health", (c) => c.json({ ok: true, version: VERSION }));

api.get("/push/key", async (c) => c.json({ public_key: (await getVapidKeys(c.env.DB)).publicKey }));

function topicParam(raw: string): string {
	if (!isValidTopic(raw)) throw new InputError("Topic names are 1-64 letters, digits, - or _.", "topic");
	return raw;
}

async function readBody(req: Request): Promise<string> {
	const len = Number(req.headers.get("content-length") ?? 0);
	if (len > MAX_BODY_BYTES) throw new InputError(`Request body is limited to ${MAX_BODY_BYTES / 1024} KB.`);
	const text = await req.text();
	if (text.length > MAX_BODY_BYTES) throw new InputError(`Request body is limited to ${MAX_BODY_BYTES / 1024} KB.`);
	return text;
}

async function readJson<T>(req: Request): Promise<T> {
	const text = await readBody(req);
	try {
		return (text ? JSON.parse(text) : {}) as T;
	} catch {
		throw new InputError("Body must be JSON.");
	}
}

/**
 * Publish. JSON body `{ body, title?, url?, priority?, tags? }`, or any non-JSON body as the
 * notification text, with `title`, `url`, `priority`, `tags` as optional query parameters.
 */
api.post("/topics/:topic/messages", async (c) => {
	const topic = topicParam(c.req.param("topic"));
	const now = nowSec();
	await authorize(c.env.DB, c.req.raw, topic, "write", now, (p) => c.executionCtx.waitUntil(p));
	const isJson = (c.req.header("content-type") ?? "").toLowerCase().includes("application/json");
	let input: PublishInput;
	if (isJson) {
		input = await readJson<PublishInput>(c.req.raw);
		if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InputError("Body must be a JSON object.");
	} else {
		const q = c.req.query();
		input = { body: await readBody(c.req.raw), title: q.title, url: q.url, priority: q.priority, tags: q.tags };
	}
	const m = buildMessage(topic, input, now, retentionSeconds(c.env));
	const { devices } = await publish(c.env, (p) => c.executionCtx.waitUntil(p), m, vapidSubject(c.env, c.req.raw));
	return c.json({ message: m, devices }, 201);
});

api.get("/topics/:topic/messages", async (c) => {
	const topic = topicParam(c.req.param("topic"));
	const now = nowSec();
	await authorize(c.env.DB, c.req.raw, topic, "read", now, (p) => c.executionCtx.waitUntil(p));
	const since = Number(c.req.query("since") ?? 0);
	const limit = Number(c.req.query("limit") ?? 100);
	const messages = await listMessages(c.env.DB, {
		topics: [topic],
		since: Number.isFinite(since) && since > 0 ? Math.floor(since) : undefined,
		limit: Number.isFinite(limit) ? Math.min(MAX_LIST, Math.max(1, Math.floor(limit))) : 100,
		now,
	});
	return c.json({ topic, messages });
});

function parseSubscription(raw: unknown): PushSubscriptionJSON {
	const s = raw as Partial<PushSubscriptionJSON> | null;
	if (!s || typeof s.endpoint !== "string" || !isAcceptableEndpoint(s.endpoint)) throw new InputError("subscription.endpoint must be the browser's https push endpoint.", "subscription");
	const p256dh = s.keys?.p256dh;
	const auth = s.keys?.auth;
	if (typeof p256dh !== "string" || !/^[-_A-Za-z0-9]{86,88}={0,2}$/.test(p256dh)) throw new InputError("subscription.keys.p256dh is missing or malformed.", "subscription");
	if (typeof auth !== "string" || !/^[-_A-Za-z0-9]{21,24}={0,2}$/.test(auth)) throw new InputError("subscription.keys.auth is missing or malformed.", "subscription");
	return { endpoint: s.endpoint, keys: { p256dh: p256dh.replace(/=+$/, ""), auth: auth.replace(/=+$/, "") } };
}

/** Body: `{ subscription: PushSubscription.toJSON() }` (the bare subscription object also works). */
api.post("/topics/:topic/subscriptions", async (c) => {
	const topic = topicParam(c.req.param("topic"));
	const now = nowSec();
	const { tokenId } = await authorize(c.env.DB, c.req.raw, topic, "read", now, (p) => c.executionCtx.waitUntil(p));
	const b = await readJson<{ subscription?: unknown; endpoint?: unknown }>(c.req.raw);
	const sub = parseSubscription(b.subscription ?? b);
	const id = (await sha256Hex(sub.endpoint)).slice(0, 16);
	const { created } = await addSubscription(c.env.DB, topic, { id, endpoint: sub.endpoint, p256dh: sub.keys.p256dh, auth: sub.keys.auth, created_at: now, token_id: tokenId });
	return c.json({ id, topic, created }, created ? 201 : 200);
});

/** Body: `{ endpoint }`. No token needed: the endpoint is an unguessable capability URL. */
api.delete("/topics/:topic/subscriptions", async (c) => {
	const topic = topicParam(c.req.param("topic"));
	const b = await readJson<{ endpoint?: unknown; subscription?: { endpoint?: unknown } }>(c.req.raw);
	const endpoint = b.endpoint ?? b.subscription?.endpoint;
	if (typeof endpoint !== "string" || !endpoint) throw new InputError("Send the subscription endpoint to remove.", "endpoint");
	const removed = await removeSubscriptions(c.env.DB, topic, [endpoint]);
	return c.json({ removed });
});

api.all("*", (c) => c.json({ error: "Not found" }, 404));
