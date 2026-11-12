import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateToken, hashToken } from "../src/worker/auth";
import { handleNtfy } from "../src/worker/ntfy-api";
import { runScheduled } from "../src/worker/service";
import { insertToken } from "../src/worker/store";
import { fakeEnv, lines, req } from "./helpers";

async function setup() {
	const f = await fakeEnv();
	const token = generateToken();
	await insertToken(f.env.DB, {
		id: "tok1",
		label: "phone",
		token_hash: await hashToken(token),
		prefix: token.slice(0, 7),
		grants: JSON.stringify([{ topic: "mytopic", read: true, write: true }, { topic: "readonly", read: true, write: false }]),
		created_at: 1,
		last_used_at: null,
		expires_at: null,
	});
	const call = async (path: string, init: RequestInit = {}) => {
		const res = await handleNtfy(req(path, init), f.env, f.ctx);
		if (!res) throw new Error(`no route for ${path}`);
		return res;
	};
	const auth = { authorization: `Bearer ${token}` };
	return { ...f, token, call, auth };
}

const upstreamCalls: { url: string; init: RequestInit }[] = [];
afterEach(() => {
	vi.unstubAllGlobals();
	upstreamCalls.length = 0;
});
function stubUpstream() {
	vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
		upstreamCalls.push({ url, init });
		return new Response("{}", { status: 200 });
	});
}

describe("ntfy HTTP API", () => {
	it("answers the probes apps and monitors use", async () => {
		const s = await setup();
		expect(await (await s.call("/v1/health")).json()).toEqual({ healthy: true });
		const cfg = (await (await s.call("/v1/config")).json()) as Record<string, unknown>;
		expect(cfg).toMatchObject({ enable_login: false, enable_signup: false, base_url: "" });
		expect((await s.call("/", { method: "HEAD" })).status).toBe(200);
		expect((await s.call("/mytopic", { method: "OPTIONS" })).headers.get("access-control-allow-origin")).toBe("*");
		expect(await handleNtfy(req("/does/not/exist"), s.env, s.ctx)).toBeNull();
	});

	it("rejects anonymous and unauthorized publishers like ntfy", async () => {
		const s = await setup();
		const anon = await s.call("/mytopic", { method: "POST", body: "hi" });
		expect(anon.status).toBe(403);
		expect(await anon.json()).toMatchObject({ code: 40301, http: 403, error: "forbidden" });
		expect((await s.call("/mytopic", { method: "POST", body: "hi", headers: { authorization: "Bearer tk_wrong" } })).status).toBe(401);
		expect((await s.call("/readonly", { method: "PUT", body: "hi", headers: s.auth })).status).toBe(403);
		expect(s.broadcasts).toHaveLength(0);
	});

	it("publishes, fans out, wakes iOS upstream, and serves the iOS poll by id", async () => {
		stubUpstream();
		const s = await setup();
		const res = await s.call("/mytopic", { method: "POST", body: "Door open", headers: { ...s.auth, Title: "Home", Priority: "high", Tags: "door" } });
		expect(res.status).toBe(200);
		const m = (await res.json()) as { id: string; event: string };
		expect(m).toMatchObject({ event: "message", topic: "mytopic", title: "Home", message: "Door open", priority: 4, tags: ["door"] });
		expect(s.broadcasts.map((b) => b.id)).toEqual([m.id]);

		await Promise.all(s.waits);
		const hash = createHash("sha256").update("https://ntfy.example.com/mytopic").digest("hex");
		expect(upstreamCalls).toHaveLength(1);
		expect(upstreamCalls[0].url).toBe(`https://upstream.example.net/${hash}`);
		expect((upstreamCalls[0].init.headers as Record<string, string>)["X-Poll-ID"]).toBe(m.id);
		expect(String(upstreamCalls[0].init.body)).toBe("");

		// What the iOS app does after the wakeup: GET <base>/<topic>/json?poll=1&id=<poll_id>, Basic auth.
		const poll = await s.call(`/mytopic/json?poll=1&id=${m.id}`, { headers: { authorization: "Basic " + btoa(`lemmeknow:${s.token}`) } });
		expect(poll.headers.get("content-type")).toContain("application/x-ndjson");
		const body = await poll.text();
		expect(body.trim().split("\n")).toHaveLength(1); // iOS decodes the whole body as one message
		expect(JSON.parse(body)).toMatchObject({ id: m.id, message: "Door open", title: "Home" });
	});

	it("does not wake upstream for uncached messages or when disabled", async () => {
		stubUpstream();
		const s = await setup();
		await s.call("/mytopic", { method: "POST", body: "x", headers: { ...s.auth, Cache: "no" } });
		await Promise.all(s.waits);
		expect(upstreamCalls).toHaveLength(0);
		expect(s.broadcasts).toHaveLength(1);

		const off = await setup();
		off.env.UPSTREAM_BASE_URL = "";
		await off.call("/mytopic", { method: "POST", body: "x", headers: off.auth });
		await Promise.all(off.waits);
		expect(upstreamCalls).toHaveLength(0);
	});

	it("publishes JSON to / and via GET /<topic>/publish", async () => {
		const s = await setup();
		const r = await s.call("/", { method: "POST", headers: s.auth, body: JSON.stringify({ topic: "mytopic", message: "json!", priority: 2 }) });
		expect(await r.json()).toMatchObject({ topic: "mytopic", message: "json!", priority: 2 });
		const g = await s.call(`/mytopic/trigger?message=get&auth=${btoa(`Bearer ${s.token}`).replace(/=+$/, "")}`);
		expect(await g.json()).toMatchObject({ message: "get" });
	});

	it("polls in json, sse and raw formats with since", async () => {
		const s = await setup();
		await s.call("/mytopic", { method: "POST", body: "one", headers: s.auth });
		await s.call("/mytopic", { method: "POST", body: "two", headers: s.auth });
		const json = await lines(await s.call("/mytopic/json?poll=1", { headers: s.auth }));
		expect(json.map((m) => m.message)).toEqual(["one", "two"]);
		const since = await lines(await s.call(`/mytopic/json?poll=1&since=${json[0].id}`, { headers: s.auth }));
		expect(since.map((m) => m.message)).toEqual(["two"]);
		const sse = await (await s.call("/mytopic/sse?poll=1&since=all", { headers: s.auth })).text();
		expect(sse).toMatch(/^data: \{.*"message":"one".*\}\n\ndata: /);
		expect(await (await s.call("/mytopic/raw?poll=1", { headers: s.auth })).text()).toBe("one\ntwo\n");
	});

	it("checks read access for /auth and multi-topic subscriptions", async () => {
		const s = await setup();
		expect(await (await s.call("/mytopic/auth", { headers: s.auth })).json()).toEqual({ success: true });
		expect((await s.call("/mytopic,readonly/json?poll=1", { headers: s.auth })).status).toBe(200);
		expect((await s.call("/mytopic,other/json?poll=1", { headers: s.auth })).status).toBe(403);
		expect((await s.call("/mytopic/auth")).status).toBe(403);
	});

	it("requires a WebSocket upgrade on /ws", async () => {
		const s = await setup();
		const r = await s.call("/mytopic/ws", { headers: s.auth });
		expect(r.status).toBe(400);
		expect(await r.json()).toMatchObject({ code: 40016 });
	});

	it("answers UnifiedPush discovery", async () => {
		const s = await setup();
		expect(await (await s.call("/upTopic?up=1")).json()).toEqual({ unifiedpush: { version: 1 } });
	});

	it("delivers scheduled messages from the cron", async () => {
		stubUpstream();
		const s = await setup();
		const r = (await (await s.call("/mytopic", { method: "POST", body: "later", headers: { ...s.auth, Delay: "1m" } })).json()) as { id: string; time: number };
		expect(s.broadcasts).toHaveLength(0);
		expect(await lines(await s.call("/mytopic/json?poll=1", { headers: s.auth }))).toHaveLength(0);
		expect((await lines(await s.call("/mytopic/json?poll=1&scheduled=1", { headers: s.auth }))).map((m) => m.id)).toEqual([r.id]);

		vi.useFakeTimers({ now: (r.time + 1) * 1000, toFake: ["Date"] });
		try {
			const out = await runScheduled(s.env, (p) => void s.waits.push(p));
			expect(out.delivered).toBe(1);
		} finally {
			vi.useRealTimers();
		}
		expect(s.broadcasts.map((b) => b.id)).toEqual([r.id]);
		await Promise.all(s.waits);
		expect(upstreamCalls).toHaveLength(1);
	});
});
