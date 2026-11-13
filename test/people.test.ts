import { afterEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/worker/auth";
import { addSubscription, getSubscriptions, insertToken } from "../src/worker/store";
import { b64url, b64urlDecode, utf8 } from "../src/worker/util";
import { fakeBrowserSubscription, fakeEnv, json } from "./helpers";

// Localhost skips the Access JWT check; x-dev-access-email picks who we are (see access.ts).
const LOCAL = "http://localhost:5173";
const as = (email: string, init: RequestInit = {}): RequestInit => ({ ...init, headers: { ...(init.headers as Record<string, string>), "x-dev-access-email": email } });
const OWNER = "owner@example.com";
const BOB = "bob@example.com";

afterEach(() => vi.unstubAllGlobals());

async function setup(adminEmails = OWNER) {
	const f = await fakeEnv({ ADMIN_EMAILS: adminEmails });
	const local = (path: string, email: string, init: RequestInit = {}) => f.call(path, as(email, init), LOCAL);
	const body = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
	return { ...f, local, body };
}

type Me = { email: string; role: string; token: string; topics: { name: string; can_write: boolean }[] };

describe("users and login", () => {
	it("only admins get the dashboard; strangers are not invited", async () => {
		const s = await setup();
		expect((await s.local("/api/admin/me", OWNER)).status).toBe(200);
		expect((await s.local("/api/admin/me", BOB)).status).toBe(403);
		expect((await s.local("/api/me", BOB)).status).toBe(403);
		expect((await s.local("/admin", BOB)).status).toBe(403);
		const login = await s.local("/login", BOB);
		expect(login.status).toBe(403);
		expect(await login.text()).toContain("Not invited");
		const ok = await s.local("/login", OWNER);
		expect(ok.status).toBe(302);
		expect(ok.headers.get("location")).toBe("/?signed_in=1");
	});

	it("invites a member who signs in, gets a permanent token for their topics, and loses it all on removal", async () => {
		const s = await setup();
		expect((await s.local("/api/admin/users", OWNER, json({ email: "Bob@Example.com ", grants: [{ topic: "alerts", read: true, write: true }] }))).status).toBe(201);
		expect((await s.local("/api/admin/users", OWNER, json({ email: BOB }))).status).toBe(409);
		const users = await s.body<{ email: string; role: string; source: string }[]>(s.local("/api/admin/users", OWNER));
		expect(users.map((u) => [u.email, u.role, u.source])).toEqual([
			[OWNER, "admin", "config"],
			[BOB, "member", "dashboard"],
		]);

		expect((await s.local("/api/admin/me", BOB)).status).toBe(403); // members don't get the dashboard
		expect((await s.local("/login", BOB)).status).toBe(302);
		await s.local("/api/admin/topics", OWNER, json({ name: "alerts" }));
		await s.local("/api/admin/topics", OWNER, json({ name: "secret" }));
		const me = await s.body<Me>(s.local("/api/me", BOB));
		expect(me).toMatchObject({ email: BOB, role: "member" });
		expect(me.token).toMatch(/^lk_/);
		expect(me.topics.map((t) => t.name)).toEqual(["alerts"]);
		// Same token every time: copy it once, use it forever.
		expect((await s.body<Me>(s.local("/api/me", BOB))).token).toBe(me.token);
		const auth = { authorization: `Bearer ${me.token}` };
		expect((await s.call("/api/v1/topics/alerts/messages", json({ title: "hi" }, auth))).status).toBe(201);
		expect((await s.call("/api/v1/topics/secret/messages", json({ title: "hi" }, auth))).status).toBe(403);

		// Widening their grants updates their personal token.
		expect((await s.local(`/api/admin/users/${encodeURIComponent(BOB)}`, OWNER, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ grants: [{ topic: "*", read: true, write: true }] }) })).status).toBe(200);
		expect((await s.call("/api/v1/topics/secret/messages", json({ title: "hi" }, auth))).status).toBe(201);

		const dev = await fakeBrowserSubscription();
		await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: dev }, auth));
		expect((await s.local(`/api/admin/users/${encodeURIComponent(OWNER)}`, OWNER, { method: "DELETE" })).status).toBe(400);
		const del = await s.body<{ tokens: number; devices: number }>(s.local(`/api/admin/users/${encodeURIComponent(BOB)}`, OWNER, { method: "DELETE" }));
		expect(del).toMatchObject({ tokens: 1, devices: 1 });
		expect((await s.local("/api/me", BOB)).status).toBe(403);
		expect((await s.call("/api/v1/topics/alerts/messages", json({ title: "hi" }, auth))).status).toBe(401);
		expect(await getSubscriptions(s.env.DB, "alerts")).toEqual([]);
	});

	it("rotating the personal token keeps the phone subscribed", async () => {
		const s = await setup();
		const me = await s.body<Me>(s.local("/api/me", OWNER));
		const dev = await fakeBrowserSubscription();
		await s.call("/api/v1/topics/alerts/subscriptions", json({ subscription: dev }, { authorization: `Bearer ${me.token}` }));
		const next = await s.body<Me>(s.local("/api/me/token/rotate", OWNER, { method: "POST" }));
		expect(next.token).not.toBe(me.token);
		expect((await s.call("/api/v1/topics/alerts/messages", { headers: { authorization: `Bearer ${me.token}` } })).status).toBe(401);
		expect((await s.call("/api/v1/topics/alerts/messages", { headers: { authorization: `Bearer ${next.token}` } })).status).toBe(200);
		expect(await getSubscriptions(s.env.DB, "alerts")).toHaveLength(1);
	});

	it("pairs the Home Screen app with a one-time code from Safari", async () => {
		const s = await setup();
		const me = await s.body<Me>(s.local("/api/me", OWNER));
		const { code } = await s.body<{ code: string }>(s.local("/api/me/pair", OWNER, { method: "POST" }));
		expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
		expect((await s.call("/api/v1/pair", json({ code: "WRONGCOD" }))).status).toBe(400);
		const paired = await s.body<{ email: string; token: string }>(s.call("/api/v1/pair", json({ code: code.toLowerCase().replace("-", " ") })));
		expect(paired).toMatchObject({ email: OWNER, token: me.token });
		expect((await s.call("/api/v1/pair", json({ code }))).status).toBe(400); // one-time
		const viaToken = await s.body<Me>(s.call("/api/v1/me", { headers: { authorization: `Bearer ${me.token}` } }));
		expect(viaToken.email).toBe(OWNER);
	});

	it("without configured owners, the first Access identity is admin until someone is invited", async () => {
		const s = await setup("");
		expect((await s.local("/api/admin/me", "first@example.com")).status).toBe(200);
		expect((await s.local("/api/admin/users", "first@example.com", json({ email: BOB }))).status).toBe(201);
		const users = await s.body<{ email: string; role: string }[]>(s.local("/api/admin/users", "first@example.com"));
		expect(users.map((u) => [u.email, u.role])).toEqual([
			[BOB, "member"],
			["first@example.com", "admin"],
		]);
		expect((await s.local("/api/admin/me", "stranger@example.com")).status).toBe(403);
	});

	it("legacy hash-only tokens are not viewable and can be replaced in place", async () => {
		const s = await setup();
		await insertToken(s.env.DB, { id: "old", label: "Old phone", token_hash: await hashToken("tk_legacy"), prefix: "tk_l", grants: JSON.stringify([{ topic: "alerts", read: true, write: true }]), created_at: 1, last_used_at: null, expires_at: null });
		const dev = await fakeBrowserSubscription();
		await addSubscription(s.env.DB, "alerts", { endpoint: dev.endpoint, p256dh: dev.keys.p256dh, auth: dev.keys.auth, token_id: "old" }, 1);
		const before = await s.body<{ id: string; token: string | null }[]>(s.local("/api/admin/tokens", OWNER));
		expect(before).toEqual([expect.objectContaining({ id: "old", token: null })]);
		const r = await s.body<{ token: string; info: { id: string; label: string } }>(s.local("/api/admin/tokens/old/replace", OWNER, { method: "POST" }));
		expect(r.info.label).toBe("Old phone");
		expect(r.token).toMatch(/^lk_/);
		const subs = await getSubscriptions(s.env.DB, "alerts");
		expect(subs.map((x) => x.token_id)).toEqual([r.info.id]);
		expect((await s.call("/api/v1/topics/alerts/messages", { headers: { authorization: "Bearer tk_legacy" } })).status).toBe(401);
	});
});

describe("Access External Evaluation", () => {
	async function team() {
		const kp = (await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
		const kid = crypto.randomUUID();
		const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid };
		vi.stubGlobal("fetch", async (input: Request | string) => {
			const url = typeof input === "string" ? input : input.url;
			if (url === "https://team.example.com/cdn-cgi/access/certs") return Response.json({ keys: [pub] });
			return new Response("unexpected", { status: 500 });
		});
		const sign = async (payload: object) => {
			const h = b64url(utf8(JSON.stringify({ alg: "RS256", kid })));
			const p = b64url(utf8(JSON.stringify(payload)));
			const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", kp.privateKey, utf8(`${h}.${p}`));
			return `${h}.${p}.${b64url(sig)}`;
		};
		return { sign };
	}

	async function verifyAnswer(s: Awaited<ReturnType<typeof setup>>, token: string) {
		const { keys } = await s.body<{ keys: (JsonWebKey & { kid: string })[] }>(s.call("/access/keys"));
		const [h, p, sig] = token.split(".");
		const head = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as { kid: string; alg: string };
		expect(head.alg).toBe("RS256");
		const jwk = keys.find((k) => k.kid === head.kid);
		const key = await crypto.subtle.importKey("jwk", jwk!, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
		expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(sig), utf8(`${h}.${p}`))).toBe(true);
		return JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as { success: boolean; nonce: string; exp: number };
	}

	it("lets invited people and owners through, nobody else, and rejects forged requests", async () => {
		const s = await (async () => {
			const f = await setup();
			f.env.ACCESS_TEAM_DOMAIN = "team.example.com";
			return f;
		})();
		const t = await team();
		await s.local("/api/admin/users", OWNER, json({ email: BOB }));
		const exp = Math.floor(Date.now() / 1000) + 60;
		for (const [email, want] of [
			[BOB, true],
			[OWNER, true],
			["eve@example.com", false],
		] as const) {
			const res = await s.call("/access/evaluate", json({ token: await t.sign({ identity: { email }, nonce: `n-${email}`, exp }) }));
			expect(res.status).toBe(200);
			const ans = await verifyAnswer(s, ((await res.json()) as { token: string }).token);
			expect(ans).toMatchObject({ success: want, nonce: `n-${email}` });
		}
		const forged = (await t.sign({ identity: { email: BOB }, nonce: "x", exp })).replace(/\.[^.]+$/, ".AAAA");
		expect((await s.call("/access/evaluate", json({ token: forged }))).status).toBe(400);
		expect((await s.call("/access/evaluate", json({}))).status).toBe(400);
	});
});
