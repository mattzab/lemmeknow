import type { Grant, Role, ServerInfo, UserInfo } from "@shared/types";
import { Hono } from "hono";
import { type Env, VERSION } from "./env";
import { configAdmins, ensurePersonalToken, mintToken, normEmail, type Person, personFromRequest, removePerson, replaceToken, resolvePerson } from "./people";
import { baseUrlFor, buildMessage, fanOut, InputError, publish, retentionSeconds, vapidSubject } from "./service";
import {
	deleteToken,
	deleteTopic,
	getSubscriptions,
	getTopic,
	getVapidKeys,
	getToken,
	getUser,
	insertMessage,
	listMessages,
	listUserRows,
	listTokens,
	listTopics,
	removeSubscriptionsByToken,
	tokenCounts,
	tokenInfo,
	updateToken,
	upsertTopic,
	upsertUser,
} from "./store";
import { isValidTopic, nowSec } from "./util";

type Vars = { person: Person };
export const admin = new Hono<{ Bindings: Env; Variables: Vars }>();

// Every admin call needs a valid Cloudflare Access JWT (localhost dev excepted, see access.ts)
// from an admin. Invited members pass Access too, but only get /api/me.
admin.use("*", async (c, next) => {
	const { person, email } = await personFromRequest(c.req.raw, c.env);
	if (!email) return c.json({ error: "Cloudflare Access authentication required" }, 401);
	if (!person || person.role !== "admin") return c.json({ error: "Only admins can use the dashboard." }, 403);
	c.set("person", person);
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
	// Make sure the admin has a personal token, so the Curl page has one to offer.
	await ensurePersonalToken(c.env, c.get("person"));
	const info: ServerInfo = {
		baseUrl: baseUrlFor(c.env, c.req.raw),
		retentionSeconds: retentionSeconds(c.env),
		email: c.get("person").email,
		version: VERSION,
		vapidPublicKey: (await getVapidKeys(c.env.DB)).publicKey,
		configAdmins: configAdmins(c.env),
		accessEvaluateUrl: `${baseUrlFor(c.env, c.req.raw)}/access/evaluate`,
		accessKeysUrl: `${baseUrlFor(c.env, c.req.raw)}/access/keys`,
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
	const b = await c.req.json<{ label?: string; grants?: unknown; user_email?: string | null }>();
	const label = (b.label ?? "").trim();
	if (!label) return c.json(bad("Give the token a name, e.g. the device or script that uses it.", "label"), 400);
	const grants = cleanGrants(b.grants ?? []);
	if (typeof grants === "string") return c.json(bad(grants, "grants"), 400);
	const user_email = b.user_email ? normEmail(b.user_email) : null;
	// Tokens never expire and stay copyable: the full value is stored (only admins can read it).
	const row = await mintToken(c.env, { label, grants, user_email });
	return c.json({ token: row.token, info: tokenInfo(row) }, 201);
});

/** New value, same name, grants and owner. Devices subscribed with the old value move over. */
admin.post("/tokens/:id/replace", async (c) => {
	const row = await replaceToken(c.env, c.req.param("id"));
	if (!row) return c.json(bad("Token not found"), 404);
	return c.json({ token: row.token, info: tokenInfo(row) });
});

admin.patch("/tokens/:id", async (c) => {
	const b = await c.req.json<{ label?: string; grants?: unknown }>();
	const patch: { label?: string; grants?: Grant[] } = {};
	if (b.label !== undefined) {
		if (!b.label.trim()) return c.json(bad("Name is required", "label"), 400);
		patch.label = b.label.trim();
	}
	if (b.grants !== undefined) {
		const cur = await getToken(c.env.DB, c.req.param("id"));
		if (cur?.personal) return c.json(bad("A personal token follows its user's grants: change them on the Users page.", "grants"), 400);
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

// ---------- users ----------

admin.get("/users", async (c) => {
	const [rows, counts] = await Promise.all([listUserRows(c.env.DB), tokenCounts(c.env.DB)]);
	const owners = configAdmins(c.env);
	const out: UserInfo[] = owners.map((email) => ({ email, role: "admin", grants: [], source: "config", created_at: null, added_by: null, tokens: counts[email] ?? 0 }));
	for (const r of rows) {
		if (owners.includes(r.email)) continue;
		out.push({ email: r.email, role: r.role, grants: r.role === "admin" ? [] : (JSON.parse(r.grants) as Grant[]), source: "dashboard", created_at: r.created_at, added_by: r.added_by, tokens: counts[r.email] ?? 0 });
	}
	return c.json(out);
});

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

function cleanUser(b: { role?: unknown; grants?: unknown }): { role: Role; grants: Grant[] } | string {
	const role: Role = b.role === "admin" ? "admin" : "member";
	const grants = role === "admin" ? [] : cleanGrants(b.grants ?? []);
	return typeof grants === "string" ? grants : { role, grants };
}

/** Invite someone. Access lets them sign in via the External Evaluation rule (see /access/evaluate). */
admin.post("/users", async (c) => {
	const b = await c.req.json<{ email?: string; role?: string; grants?: unknown }>();
	const email = normEmail(b.email ?? "");
	if (!EMAIL_RE.test(email) || email.length > 254) return c.json(bad("Enter an e-mail address.", "email"), 400);
	if (configAdmins(c.env).includes(email) || (await getUser(c.env.DB, email))) return c.json(bad("That person is already a user.", "email"), 409);
	const u = cleanUser(b);
	if (typeof u === "string") return c.json(bad(u, "grants"), 400);
	const me = c.get("person");
	const now = nowSec();
	// Bootstrap ends here: whoever invites the first person is recorded as an admin.
	if (me.bootstrap) await upsertUser(c.env.DB, { email: me.email, role: "admin", grants: [], added_by: null }, now);
	await upsertUser(c.env.DB, { email, ...u, added_by: me.email }, now);
	return c.json({ ok: true }, 201);
});

admin.patch("/users/:email", async (c) => {
	const email = normEmail(c.req.param("email"));
	if (configAdmins(c.env).includes(email)) return c.json(bad("Owners are set in adminEmails (lemmeknow.config.json), not here."), 400);
	const cur = await getUser(c.env.DB, email);
	if (!cur) return c.json(bad("User not found"), 404);
	if (email === c.get("person").email) return c.json(bad("You cannot change your own role."), 400);
	const b = await c.req.json<{ role?: string; grants?: unknown }>();
	const u = cleanUser({ role: b.role ?? cur.role, grants: b.grants ?? JSON.parse(cur.grants) });
	if (typeof u === "string") return c.json(bad(u, "grants"), 400);
	await upsertUser(c.env.DB, { email, ...u, added_by: cur.added_by }, cur.created_at);
	// Keep their personal token in step with the new grants.
	const p = await resolvePerson(c.env, email);
	if (p) await ensurePersonalToken(c.env, p);
	return c.json({ ok: true });
});

/** Remove someone: they can no longer sign in, and their tokens and devices are revoked. */
admin.delete("/users/:email", async (c) => {
	const email = normEmail(c.req.param("email"));
	if (configAdmins(c.env).includes(email)) return c.json(bad("Owners are set in adminEmails (lemmeknow.config.json), not here."), 400);
	if (email === c.get("person").email) return c.json(bad("You cannot remove yourself."), 400);
	if (!(await getUser(c.env.DB, email))) return c.json(bad("User not found"), 404);
	return c.json({ ok: true, ...(await removePerson(c.env, email)) });
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
