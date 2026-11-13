import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken, hashToken } from "../src/worker/auth";
import { getSubscriptions, insertToken } from "../src/worker/store";
import { decryptPush, fakeBrowserSubscription, fakeEnv, json } from "./helpers";

async function setup() {
	const f = await fakeEnv();
	const mint = async (id: string, grants: { topic: string; read: boolean; write: boolean }[], expires_at: number | null = null) => {
		const token = generateToken();
		await insertToken(f.env.DB, { id, label: id, token_hash: await hashToken(token), prefix: token.slice(0, 7), grants: JSON.stringify(grants), created_at: 1, last_used_at: null, expires_at });
		return { authorization: `Bearer ${token}` };
	};
	const rw = await mint("rw", [{ topic: "alerts", read: true, write: true }]);
	const ro = await mint("ro", [{ topic: "alerts", read: true, write: false }]);
	return { ...f, rw, ro, mint };
}

type Sent = { url: string; headers: Headers; body: Uint8Array };
const sent: Sent[] = [];
let pushStatus = 201;
afterEach(() => {
	vi.unstubAllGlobals();
	sent.length = 0;
	pushStatus = 201;
});
function stubPushServices() {
	vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
		const req = input instanceof Request ? input : new Request(input, init);
		sent.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
		return new Response(null, { status: pushStatus });
	});
}

describe("Lemmeknow API", () => {
	it("serves health, the VAPID key, and 404s as JSON", async () => {
		const s = await setup();
		expect(await (await s.call("/api/v1/health")).json()).toMatchObject({ ok: true });
		expect(await (await s.call("/healthz")).json()).toMatchObject({ ok: true });
		const k1 = (await (await s.call("/api/v1/push/key")).json()) as { public_key: string };
		const k2 = (await (await s.call("/api/v1/push/key")).json()) as { public_key: string };
		expect(k1.public_key).toMatch(/^[\w-]{87}$/);
		expect(k2.public_key).toBe(k1.public_key); // generated once, persisted in D1
		expect(s.sql.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'vapid'").get()).toEqual({ n: 1 });
		const nf = await s.call("/api/v1/nope");
		expect(nf.status).toBe(404);
		expect(await nf.json()).toEqual({ error: "Not found" });
		expect((await s.call("/api/v1/topics/alerts/messages", { method: "OPTIONS" })).headers.get("access-control-allow-origin")).toBe("*");
	});

	it("keeps no ntfy-style routes", async () => {
		const s = await setup();
		for (const [path, method] of [["/v1/config", "GET"], ["/alerts/json", "GET"], ["/alerts", "POST"], ["/alerts", "PUT"]] as const) {
			const res = await s.call(path, { method, body: method === "GET" ? undefined : "hi" });
			// Falls through to static assets (the PWA), never an API response.
			expect(await res.text(), `${method} ${path}`).toMatch(/^asset /);
		}
	});

	it("requires a token with the right grant to publish", async () => {
		const s = await setup();
		const anon = await s.call("/api/v1/topics/alerts/messages", json({ body: "hi" }));
		expect(anon.status).toBe(403);
		expect(((await anon.json()) as { error: string }).error).toMatch(/private/);
		expect((await s.call("/api/v1/topics/alerts/messages", json({ body: "hi" }, { authorization: "Bearer lk_wrong" }))).status).toBe(401);
		expect((await s.call("/api/v1/topics/alerts/messages", json({ body: "hi" }, { authorization: "Basic Zm9vOmJhcg==" }))).status).toBe(401);
		expect((await s.call("/api/v1/topics/alerts/messages", json({ body: "hi" }, s.ro))).status).toBe(403);
		expect((await s.call("/api/v1/topics/other/messages", json({ body: "hi" }, s.rw))).status).toBe(403);
		const expired = await s.mint("old", [{ topic: "*", read: true, write: true }], 1);
		expect((await s.call("/api/v1/topics/alerts/messages", json({ body: "hi" }, expired))).status).toBe(401);
	});

	it("publishes JSON and plain-text bodies and lists them newest first", async () => {
		const s = await setup();
		const r1 = await s.call("/api/v1/topics/alerts/messages", json({ title: "Backup", body: "done", priority: 4, tags: ["ok", "nightly"], url: "https://example.com/run/1" }, s.rw));
		expect(r1.status).toBe(201);
		const { message, devices } = (await r1.json()) as { message: Record<string, unknown>; devices: number };
		expect(devices).toBe(0);
		expect(message).toMatchObject({ topic: "alerts", title: "Backup", body: "done", priority: 4, tags: ["ok", "nightly"], url: "https://example.com/run/1" });
		expect(message.id).toMatch(/^[A-Za-z0-9]{14}$/);

		const r2 = await s.call("/api/v1/topics/alerts/messages?title=Disk&priority=5&tags=a,b", { method: "POST", body: "90% full", headers: s.rw });
		expect(r2.status).toBe(201);
		expect(((await r2.json()) as { message: unknown }).message).toMatchObject({ title: "Disk", body: "90% full", priority: 5, tags: ["a", "b"] });

		const list = (await (await s.call("/api/v1/topics/alerts/messages", { headers: s.ro })).json()) as { messages: { body: string }[] };
		expect(list.messages.map((m) => m.body)).toEqual(["90% full", "done"]);
		expect((await s.call("/api/v1/topics/alerts/messages")).status).toBe(403);

		// Both messages are packed into one inbox row (one topic, one day).
		expect(s.sql.prepare("SELECT COUNT(*) AS n, SUM(count) AS c FROM inbox").get()).toEqual({ n: 1, c: 2 });
	});

	it("validates publish input", async () => {
		const s = await setup();
		const bad = async (body: unknown) => {
			const r = await s.call("/api/v1/topics/alerts/messages", json(body, s.rw));
			expect(r.status).toBe(400);
			return ((await r.json()) as { field?: string }).field;
		};
		expect(await bad({})).toBe("body");
		expect(await bad({ body: "x", priority: 9 })).toBe("priority");
		expect(await bad({ body: "x", url: "javascript:alert(1)" })).toBe("url");
		expect(await bad({ body: "x".repeat(5000) })).toBe("body");
		expect(await bad({ body: "x", tags: [1] })).toBe("tags");
		expect((await s.call("/api/v1/topics/bad%20name/messages", json({ body: "x" }, s.rw))).status).toBe(400);
		expect((await s.call("/api/v1/topics/alerts/messages", { method: "POST", body: "{nope", headers: { ...s.rw, "content-type": "application/json" } })).status).toBe(400);
	});

	it("public topics work without a token", async () => {
		const s = await setup();
		s.sql.prepare("INSERT INTO topics (name, anon_read, anon_write, created_at) VALUES ('open', 1, 0, 1)").run();
		expect((await s.call("/api/v1/topics/open/messages")).status).toBe(200);
		expect((await s.call("/api/v1/topics/open/messages", json({ body: "x" }))).status).toBe(403);
	});
});

describe("Web Push subscriptions and delivery", () => {
	it("subscribes a device, pushes an encrypted payload on publish, and unsubscribes", async () => {
		const s = await setup();
		stubPushServices();
		const iphone = await fakeBrowserSubscription("https://web.push.apple.com/QGzVt0iphone");
		const android = await fakeBrowserSubscription("https://fcm.googleapis.com/fcm/send/android1");

		expect((await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: iphone }))).status).toBe(403);
		const sub1 = await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: { endpoint: iphone.endpoint, keys: iphone.keys } }, s.ro));
		expect(sub1.status).toBe(201);
		expect(await sub1.json()).toMatchObject({ topic: "alerts", created: true, id: expect.stringMatching(/^[0-9a-f]{16}$/) });
		// Re-subscribing the same endpoint is idempotent.
		expect((await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: iphone }, s.ro))).status).toBe(200);
		expect((await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: android }, s.rw))).status).toBe(201);
		expect(s.sql.prepare("SELECT COUNT(*) AS n, json_array_length(subs) AS d FROM push_subs").get()).toEqual({ n: 1, d: 2 });

		const pub = await s.call("/api/v1/topics/alerts/messages", json({ title: "Hello", body: "From the Worker", priority: 5, url: "https://example.com" }, s.rw));
		expect(((await pub.json()) as { devices: number }).devices).toBe(2);
		await s.settle();
		expect(sent.map((x) => new URL(x.url).host).sort()).toEqual(["fcm.googleapis.com", "web.push.apple.com"]);
		const apple = sent.find((x) => x.url === iphone.endpoint)!;
		expect(apple.headers.get("urgency")).toBe("high");
		expect(apple.headers.get("content-encoding")).toBe("aes128gcm");
		const aud = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(apple.headers.get("authorization")!.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
		expect(aud).toMatchObject({ aud: "https://web.push.apple.com", sub: "https://lemmeknow.example.com" });
		const payload = JSON.parse(await decryptPush(apple.body, iphone.privateKey, iphone.keys.p256dh, iphone.keys.auth));
		expect(payload).toMatchObject({ topic: "alerts", title: "Hello", body: "From the Worker", priority: 5, url: "https://example.com" });

		const del = await s.call("/api/v1/topics/alerts/subscriptions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint: android.endpoint }) });
		expect(await del.json()).toEqual({ removed: 1 });
		expect((await getSubscriptions(s.env.DB, "alerts")).map((x) => x.endpoint)).toEqual([iphone.endpoint]);
	});

	it("drops subscriptions the push service reports as gone", async () => {
		const s = await setup();
		stubPushServices();
		const dev = await fakeBrowserSubscription();
		await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: dev }, s.ro));
		pushStatus = 410;
		await s.call("/api/v1/topics/alerts/messages", json({ body: "x" }, s.rw));
		await s.settle();
		expect(sent).toHaveLength(1);
		expect(await getSubscriptions(s.env.DB, "alerts")).toEqual([]);
		expect(s.sql.prepare("SELECT COUNT(*) AS n FROM push_subs").get()).toEqual({ n: 0 });
	});

	it("keeps subscriptions on transient failures", async () => {
		const s = await setup();
		stubPushServices();
		const dev = await fakeBrowserSubscription();
		await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: dev }, s.ro));
		pushStatus = 503;
		await s.call("/api/v1/topics/alerts/messages", json({ body: "x" }, s.rw));
		await s.settle();
		expect(await getSubscriptions(s.env.DB, "alerts")).toHaveLength(1);
	});

	it("rejects bogus subscriptions", async () => {
		const s = await setup();
		const dev = await fakeBrowserSubscription();
		for (const sub of [{ ...dev, endpoint: "http://insecure.example.com/x" }, { ...dev, endpoint: "https://127.0.0.1/x" }, { endpoint: dev.endpoint, keys: { p256dh: "short", auth: dev.keys.auth } }, {}]) {
			const r = await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: sub }, s.ro));
			expect(r.status).toBe(400);
		}
	});
});

describe("dashboard API", () => {
	const LOCAL = "http://localhost:5173"; // `cf dev` bypasses Access; production always verifies the JWT

	it("is closed without Cloudflare Access", async () => {
		const s = await setup();
		expect((await s.call("/api/admin/me")).status).toBe(401);
		expect((await s.call("/admin")).status).toBe(401);
		expect((await s.call("/admin/tokens")).status).toBe(401);
		expect((await s.call("/admin", {}, LOCAL)).status).toBe(200);
	});

	it("mints tokens that stay viewable, sends test pushes, and revoking a token removes its devices", async () => {
		const s = await setup();
		stubPushServices();
		const created = (await (await s.call("/api/admin/tokens", json({ label: "iPhone", grants: [{ topic: "alerts", read: true, write: true }] }), LOCAL)).json()) as {
			token: string;
			info: { id: string; prefix: string };
		};
		expect(created.token).toMatch(/^lk_[a-z0-9]{32}$/);
		// Tokens stay copyable from the dashboard and never expire.
		const tokens = (await (await s.call("/api/admin/tokens", {}, LOCAL)).json()) as { id: string; token: string | null; expires_at: number | null }[];
		expect(tokens.find((t) => t.id === created.info.id)).toMatchObject({ token: created.token, expires_at: null });
		const auth = { authorization: `Bearer ${created.token}` };

		const dev = await fakeBrowserSubscription();
		await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: dev }, auth));
		const topics = (await (await s.call("/api/admin/topics", {}, LOCAL)).json()) as { name: string; devices: number }[];
		expect(topics).toEqual([]); // subscribing does not create the topic row; publishing does

		const test = (await (await s.call("/api/admin/publish", json({ topic: "alerts", title: "Test", body: "Hello from the dashboard", wait: true }), LOCAL)).json()) as {
			push: { devices: number; sent: number };
		};
		expect(test.push).toMatchObject({ devices: 1, sent: 1 });
		const listed = (await (await s.call("/api/admin/topics", {}, LOCAL)).json()) as { name: string; devices: number; stored: number }[];
		expect(listed).toEqual([expect.objectContaining({ name: "alerts", devices: 1, stored: 1, public_read: false, public_write: false })]);
		const devices = (await (await s.call("/api/admin/topics/alerts/devices", {}, LOCAL)).json()) as { push_service: string }[];
		expect(devices).toEqual([expect.objectContaining({ push_service: "web.push.apple.com", token_id: created.info.id })]);

		const del = (await (await s.call(`/api/admin/tokens/${created.info.id}`, { method: "DELETE" }, LOCAL)).json()) as { devices_removed: number };
		expect(del.devices_removed).toBe(1);
		expect((await s.call("/api/v1/topics/alerts/messages", { headers: auth })).status).toBe(401);
		expect(await getSubscriptions(s.env.DB, "alerts")).toEqual([]);
	});
});
