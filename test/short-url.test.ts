import { afterEach, describe, expect, it, vi } from "vitest";
import { curlGet, curlPost, publishGetUrl, publishUrl, shq } from "../src/shared/curl";
import { generateToken, hashToken } from "../src/worker/auth";
import { insertToken, listMessages } from "../src/worker/store";
import { nowSec } from "../src/worker/util";
import { fakeEnv, HOST, json } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

async function setup() {
	const f = await fakeEnv();
	const mint = async (id: string, grants: { topic: string; read: boolean; write: boolean }[]) => {
		const token = generateToken();
		await insertToken(f.env.DB, { id, label: id, token_hash: await hashToken(token), prefix: token.slice(0, 7), grants: JSON.stringify(grants), created_at: 1, last_used_at: null, expires_at: null, token });
		return token;
	};
	const rw = await mint("rw", [{ topic: "alerts", read: true, write: true }]);
	const ro = await mint("ro", [{ topic: "alerts", read: true, write: false }]);
	const inbox = () => listMessages(f.env.DB, { topics: ["alerts"], limit: 50, now: nowSec() });
	return { ...f, rw, ro, inbox };
}

describe("short publish URL /<token>/<topic>", () => {
	it("GET publishes with options from the query", async () => {
		const s = await setup();
		const res = await s.call(`/${s.rw}/alerts?title=Backup&body=Nightly%20backup+done&priority=4&tags=ok,db`);
		expect(res.status).toBe(201);
		expect(await res.json()).toMatchObject({ ok: true, topic: "alerts", devices: 0 });
		const [m] = await s.inbox();
		expect(m).toMatchObject({ title: "Backup", body: "Nightly backup done", priority: 4, tags: ["ok", "db"] });
	});

	it("a bare GET or HEAD still publishes a ping; msg= is an alias for body", async () => {
		const s = await setup();
		expect((await s.call(`/${s.rw}/alerts`)).status).toBe(201);
		expect((await s.call(`/${s.rw}/alerts/`, { method: "HEAD" })).status).toBe(201);
		expect((await s.call(`/${s.rw}/alerts?msg=hello`)).status).toBe(201);
		expect((await s.inbox()).map((m) => m.body)).toEqual(["hello", "Ping", "Ping"]);
	});

	it("POST takes a text body (curl --data-raw) or JSON", async () => {
		const s = await setup();
		await s.call(`/${s.rw}/alerts?title=Disk`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "disk full" });
		await s.call(`/${s.rw}/alerts`, json({ title: "J", body: "from json", url: "https://example.com" }));
		const [j, t] = await s.inbox();
		expect(t).toMatchObject({ title: "Disk", body: "disk full" });
		expect(j).toMatchObject({ title: "J", body: "from json", url: "https://example.com" });
	});

	it("accepts Richter's webhook JSON; down is high priority", async () => {
		const s = await setup();
		const down = { title: "Backups is down", body: "No ping for 25h", status: "down", name: "Backups", url: "https://richter.example/checks/1", time: "2026-11-12T00:00:00Z" };
		const res = await s.call(`/${s.rw}/alerts`, json(down));
		expect(res.status).toBe(201);
		expect((await s.call(`/${s.rw}/alerts`, json({ ...down, title: "Backups is up", body: "Back", status: "up" }))).status).toBe(201);
		const [up, d] = await s.inbox();
		expect(d).toMatchObject({ title: "Backups is down", body: "No ping for 25h", url: "https://richter.example/checks/1", priority: 4 });
		expect(up).toMatchObject({ title: "Backups is up", priority: 3 });
	});

	it("rejects unknown tokens, read-only tokens and bad input", async () => {
		const s = await setup();
		expect((await s.call(`/lk_${"x".repeat(32)}/alerts`)).status).toBe(401);
		expect((await s.call(`/${s.ro}/alerts`)).status).toBe(403);
		expect((await s.call(`/${s.rw}/other`)).status).toBe(403);
		expect((await s.call(`/${s.rw}/bad.topic`)).status).toBe(400);
		expect((await s.call(`/${s.rw}/alerts?priority=9`)).status).toBe(400);
		expect(await s.inbox()).toEqual([]);
	});

	it("does not swallow other routes", async () => {
		const s = await setup();
		for (const p of ["/", "/sw.js", "/manifest.webmanifest", "/assets/app.js", "/icons/icon-192.png", "/alerts/messages", "/not_a_token/alerts"]) {
			expect(await (await s.call(p)).text()).toMatch(/^asset /);
		}
		expect((await s.call("/admin")).status).toBe(401);
		expect((await s.call("/login")).status).toBe(401);
		expect((await s.call("/api/v1/health")).status).toBe(200);
		expect((await s.call("/healthz")).status).toBe(200);
		expect((await s.call("/access/keys")).status).toBe(200);
		expect((await s.call(`/api/${s.rw}`)).status).toBe(404);
	});
});

describe("generated curl", () => {
	it("builds the URL and commands the route accepts", async () => {
		const s = await setup();
		expect(publishUrl("https://h.example/", "lk_abc1", "alerts")).toBe("https://h.example/lk_abc1/alerts");
		const o = { title: "Backup", body: "It's done", priority: 4, url: "https://x.example/a?b=c" };
		expect(curlPost(HOST, "lk_abc1", "alerts", o)).toBe(
			`curl -fsS -m 10 --retry 3 --data-raw 'It'\\''s done' \\\n  'https://lemmeknow.example.com/lk_abc1/alerts?title=Backup&url=https%3A%2F%2Fx.example%2Fa%3Fb%3Dc&priority=4'`,
		);
		expect(curlGet(HOST, "lk_abc1", "alerts")).toBe("curl -fsS -m 10 --retry 3 https://lemmeknow.example.com/lk_abc1/alerts");
		expect(shq("a b")).toBe("'a b'");
		// The GET URL round-trips through the Worker.
		const u = new URL(publishGetUrl(HOST, s.rw, "alerts", o));
		expect((await s.call(u.pathname + u.search)).status).toBe(201);
		expect((await s.inbox())[0]).toMatchObject({ title: "Backup", body: "It's done", priority: 4, url: "https://x.example/a?b=c" });
	});
});
