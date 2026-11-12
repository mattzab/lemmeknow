import type { Grant, ServerInfo } from "@shared/types";
import { Hono } from "hono";
import { type AccessIdentity, authenticate } from "./access";
import { generateToken, hashToken, TOKEN_PREFIX } from "./auth";
import { type Env, VERSION } from "./env";
import { hub } from "./hub";
import { NtfyError } from "./ntfy/errors";
import { parsePublish } from "./ntfy/publish";
import { isValidTopic, nowSec, Params, randomString } from "./ntfy/util";
import { baseUrlFor, cacheDurationSeconds, deliver } from "./service";
import { deleteToken, deleteTopic, getTopic, insertToken, listTokens, listTopics, recentMessages, tokenInfo, updateToken, upsertTopic } from "./store";

type Vars = { identity: AccessIdentity };
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

// Every admin call needs a valid Cloudflare Access JWT (localhost dev excepted, see access.ts).
admin.use("*", async (c, next) => {
	const id = await authenticate(c.req.raw, c.env);
	if (!id) return c.json({ error: "Cloudflare Access authentication required" }, 401);
	c.set("identity", id);
	await next();
});

const bad = (error: string, field?: string) => ({ error, ...(field ? { field } : {}) });

admin.get("/me", (c) => {
	const info: ServerInfo = {
		baseUrl: baseUrlFor(c.env, c.req.raw),
		upstreamBaseUrl: c.env.UPSTREAM_BASE_URL ?? "",
		upstreamEnabled: !!c.env.UPSTREAM_BASE_URL,
		cacheDurationSeconds: cacheDurationSeconds(c.env),
		email: c.get("identity").email,
		version: VERSION,
	};
	return c.json(info);
});

// ---------- topics ----------

async function subscriberCounts(env: Env): Promise<Record<string, number>> {
	try {
		return await hub(env).subscriberCounts();
	} catch {
		return {};
	}
}

admin.get("/topics", async (c) => c.json(await listTopics(c.env.DB, nowSec(), await subscriberCounts(c.env))));

admin.post("/topics", async (c) => {
	const b = await c.req.json<{ name?: string; description?: string; anon_read?: boolean; anon_write?: boolean }>();
	const name = (b.name ?? "").trim();
	if (!isValidTopic(name)) return c.json(bad("Topic names are 1-64 letters, digits, - or _, and not a reserved word (admin, api, assets, v1, ...).", "name"), 400);
	if (await getTopic(c.env.DB, name)) return c.json(bad("That topic already exists.", "name"), 409);
	await upsertTopic(c.env.DB, { name, description: b.description?.trim() ?? "", anon_read: !!b.anon_read, anon_write: !!b.anon_write }, nowSec());
	return c.json(await getTopic(c.env.DB, name), 201);
});

admin.patch("/topics/:name", async (c) => {
	const name = c.req.param("name");
	const cur = await getTopic(c.env.DB, name);
	if (!cur) return c.json(bad("Topic not found"), 404);
	const b = await c.req.json<{ description?: string; anon_read?: boolean; anon_write?: boolean }>();
	await upsertTopic(
		c.env.DB,
		{ name, description: b.description ?? cur.description, anon_read: b.anon_read ?? cur.anon_read, anon_write: b.anon_write ?? cur.anon_write },
		cur.created_at,
	);
	return c.json(await getTopic(c.env.DB, name));
});

admin.delete("/topics/:name", async (c) => {
	await deleteTopic(c.env.DB, c.req.param("name"));
	return c.json({ ok: true });
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
	await deleteToken(c.env.DB, c.req.param("id"));
	return c.json({ ok: true });
});

// ---------- messages ----------

admin.get("/messages", async (c) => {
	const topic = c.req.query("topic") || undefined;
	const limit = Math.min(500, Math.max(1, Number(c.req.query("limit") ?? 100) || 100));
	return c.json(await recentMessages(c.env.DB, { topic, limit, now: nowSec() }));
});

/** Send a message from the dashboard (no token needed: the caller passed Access). */
admin.post("/publish", async (c) => {
	const b = await c.req.json<{ topic?: string; message?: string; title?: string; priority?: number; tags?: string; click?: string; markdown?: boolean }>();
	const h = new Headers();
	if (b.title) h.set("x-title", b.title);
	if (b.priority) h.set("x-priority", String(b.priority));
	if (b.tags) h.set("x-tags", b.tags);
	if (b.click) h.set("x-click", b.click);
	if (b.markdown) h.set("x-markdown", "yes");
	try {
		const parsed = parsePublish(new Params(h, new URLSearchParams()), (b.topic ?? "").trim(), new TextEncoder().encode(b.message ?? ""), {
			cacheDurationSeconds: cacheDurationSeconds(c.env),
		});
		await deliver(c.env, (p) => c.executionCtx.waitUntil(p), parsed, baseUrlFor(c.env, c.req.raw));
		return c.json(parsed.message);
	} catch (e) {
		if (e instanceof NtfyError) return c.json(bad(e.message), e.http as 400);
		throw e;
	}
});

admin.all("*", (c) => c.json({ error: "Not found" }, 404));
