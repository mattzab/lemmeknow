import type { Grant, ServerInfo } from "@shared/types";
import { Hono } from "hono";
import { type AccessIdentity, authenticate } from "./access";
import { generateToken, hashToken, TOKEN_PREFIX } from "./auth";
import { type Env, VERSION } from "./env";
import { baseUrlFor, buildMessage, fanOut, InputError, publish, retentionSeconds, vapidSubject } from "./service";
import {
	deleteToken,
	deleteTopic,
	getSubscriptions,
	getTopic,
	getVapidKeys,
	insertMessage,
	insertToken,
	listMessages,
	listTokens,
	listTopics,
	removeSubscriptionsByToken,
	tokenInfo,
	updateToken,
	upsertTopic,
} from "./store";
import { isValidTopic, nowSec, randomString } from "./util";

type Vars = { identity: AccessIdentity };
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

// Every admin call needs a valid Cloudflare Access JWT (localhost dev excepted, see access.ts).
admin.use("*", async (c, next) => {
	const id = await authenticate(c.req.raw, c.env);
	if (!id) return c.json({ error: "Cloudflare Access authentication required" }, 401);
	c.set("identity", id);
	await next();
	c.header("cache-control", "no-store");
});

const bad = (error: string, field?: string) => ({ error, ...(field ? { field } : {}) });

admin.onError((e, c) => {
	if (e instanceof InputError) return c.json(bad(e.message, e.field), 400);
	console.error(JSON.stringify({ event: "admin_error", path: c.req.path, error: (e as Error).message }));
	return c.json(bad("Internal error"), 500);
});

admin.get("/me", async (c) => {
	const info: ServerInfo = {
		baseUrl: baseUrlFor(c.env, c.req.raw),
		retentionSeconds: retentionSeconds(c.env),
		email: c.get("identity").email,
		version: VERSION,
		vapidPublicKey: (await getVapidKeys(c.env.DB)).publicKey,
	};
	return c.json(info);
});

// ---------- topics ----------

admin.get("/topics", async (c) => c.json(await listTopics(c.env.DB, nowSec())));

admin.post("/topics", async (c) => {
	const b = await c.req.json<{ name?: string; description?: string; public_read?: boolean; public_write?: boolean }>();
	const name = (b.name ?? "").trim();
	if (!isValidTopic(name)) return c.json(bad("Topic names are 1-64 letters, digits, - or _, and not a reserved word (admin, api, assets, ...).", "name"), 400);
	if (await getTopic(c.env.DB, name)) return c.json(bad("That topic already exists.", "name"), 409);
	await upsertTopic(c.env.DB, { name, description: b.description?.trim() ?? "", public_read: !!b.public_read, public_write: !!b.public_write }, nowSec());
	return c.json(await getTopic(c.env.DB, name), 201);
});

admin.patch("/topics/:name", async (c) => {
	const name = c.req.param("name");
	const cur = await getTopic(c.env.DB, name);
	if (!cur) return c.json(bad("Topic not found"), 404);
	const b = await c.req.json<{ description?: string; public_read?: boolean; public_write?: boolean }>();
	await upsertTopic(
		c.env.DB,
		{ name, description: b.description ?? cur.description, public_read: b.public_read ?? cur.public_read, public_write: b.public_write ?? cur.public_write },
		cur.created_at,
	);
	return c.json(await getTopic(c.env.DB, name));
});

admin.delete("/topics/:name", async (c) => {
	await deleteTopic(c.env.DB, c.req.param("name"));
	return c.json({ ok: true });
});

/** Devices subscribed to a topic (endpoint host only: the full endpoint is a capability URL). */
admin.get("/topics/:name/devices", async (c) => {
	const subs = await getSubscriptions(c.env.DB, c.req.param("name"));
	return c.json(subs.map((s) => ({ id: s.id, push_service: new URL(s.endpoint).host, created_at: s.created_at, token_id: s.token_id })));
});

// ---------- tokens ----------

function cleanGrants(raw: unknown): Grant[] | string {
	if (!Array.isArray(raw)) return "grants must be a list";
	const out: Grant[] = [];
	for (const g of raw as Partial<Grant>[]) {
		const topic = String(g?.topic ?? "").trim();
		if (!/^[-_A-Za-z0-9*]{1,64}$/.test(topic)) return `Invalid topic pattern "${topic}": use letters, digits, - _ and * wildcards.`;
		if (!g.read && !g.write) continue;
		out.push({ topic, read: !!g.read, write: !!g.write });
	}
	return out;
}

admin.get("/tokens", async (c) => c.json(await listTokens(c.env.DB)));

admin.post("/tokens", async (c) => {
	const b = await c.req.json<{ label?: string; grants?: unknown; expires_in_days?: number | null }>();
	const label = (b.label ?? "").trim();
	if (!label) return c.json(bad("Give the token a name, e.g. the device or script that uses it.", "label"), 400);
	const grants = cleanGrants(b.grants ?? []);
	if (typeof grants === "string") return c.json(bad(grants, "grants"), 400);
	const now = nowSec();
	const token = generateToken();
	const row = {
		id: randomString(16),
		label,
		token_hash: await hashToken(token),
		prefix: token.slice(0, TOKEN_PREFIX.length + 4),
		grants: JSON.stringify(grants),
		created_at: now,
		last_used_at: null,
		expires_at: b.expires_in_days ? now + Math.round(b.expires_in_days * 86400) : null,
	};
	await insertToken(c.env.DB, row);
	// The plaintext token is returned exactly once; only its SHA-256 is stored.
	return c.json({ token, info: tokenInfo(row) }, 201);
});

admin.patch("/tokens/:id", async (c) => {
	const b = await c.req.json<{ label?: string; grants?: unknown }>();
	const patch: { label?: string; grants?: Grant[] } = {};
	if (b.label !== undefined) {
		if (!b.label.trim()) return c.json(bad("Name is required", "label"), 400);
		patch.label = b.label.trim();
	}
	if (b.grants !== undefined) {
		const g = cleanGrants(b.grants);
		if (typeof g === "string") return c.json(bad(g, "grants"), 400);
		patch.grants = g;
	}
	if (!(await updateToken(c.env.DB, c.req.param("id"), patch))) return c.json(bad("Token not found"), 404);
	return c.json({ ok: true });
});

admin.delete("/tokens/:id", async (c) => {
	const id = c.req.param("id");
	await deleteToken(c.env.DB, id);
	// Devices that subscribed with this token stop receiving pushes too.
	const devices = await removeSubscriptionsByToken(c.env.DB, id);
	return c.json({ ok: true, devices_removed: devices });
});

// ---------- messages ----------

admin.get("/messages", async (c) => {
	const topic = c.req.query("topic") || undefined;
	const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
	return c.json(await listMessages(c.env.DB, { topics: topic ? [topic] : undefined, limit, now: nowSec() }));
});

/**
 * Send a notification from the dashboard (no token needed: the caller passed Access).
 * `wait: true` pushes inline and returns per-device results, for the "Send test" button.
 */
admin.post("/publish", async (c) => {
	const b = await c.req.json<{ topic?: string; title?: string; body?: string; url?: string; priority?: number; tags?: string | string[]; wait?: boolean }>();
	const now = nowSec();
	const m = buildMessage((b.topic ?? "").trim(), b, now, retentionSeconds(c.env));
	const subject = vapidSubject(c.env, c.req.raw);
	if (b.wait) {
		await insertMessage(c.env.DB, m, now);
		return c.json({ message: m, push: await fanOut(c.env, m, subject) });
	}
	const { devices } = await publish(c.env, (p) => c.executionCtx.waitUntil(p), m, subject);
	return c.json({ message: m, devices });
});

admin.all("*", (c) => c.json({ error: "Not found" }, 404));
