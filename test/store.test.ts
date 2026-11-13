import { describe, expect, it } from "vitest";
import { buildMessage } from "../src/worker/service";
import { addSubscription, ensureSchema, getSubscriptions, getVapidKeys, insertMessage, listMessages, MIGRATIONS, pruneExpired, removeSubscriptions, resetSchemaFlag } from "../src/worker/store";
import { fakeD1 } from "./fake-d1";

async function db() {
	const f = fakeD1();
	resetSchemaFlag();
	await ensureSchema(f.db as unknown as D1Database);
	return { ...f, d1: f.db as unknown as D1Database };
}

const sub = (n: number) => ({ id: `id${n}`, endpoint: `https://web.push.apple.com/dev${n}`, p256dh: "p", auth: "a", created_at: n, token_id: null });

describe("store", () => {
	it("migrates an existing 0.1 database: drops the old cache, keeps topics and tokens", async () => {
		const f = fakeD1();
		const d1 = f.db as unknown as D1Database;
		resetSchemaFlag();
		// Apply the three shipped migrations only, as a 0.1 deployment would have.
		for (const m of MIGRATIONS.slice(0, 3)) for (const stmt of m.split(";").map((x) => x.trim()).filter(Boolean)) f.sql.exec(stmt);
		f.sql.exec("INSERT INTO settings (key, value) VALUES ('schema_version', '3')");
		f.sql.exec("INSERT INTO topics (name, created_at) VALUES ('alerts', 1)");
		f.sql.exec("INSERT INTO tokens (id, label, token_hash, prefix, created_at) VALUES ('t', 'phone', 'h', 'tk_a', 1)");
		await ensureSchema(d1);
		const tables = (f.sql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
		expect(tables).toEqual(["inbox", "push_subs", "settings", "tokens", "topics"]);
		expect(f.sql.prepare("SELECT value FROM settings WHERE key = 'schema_version'").get()).toEqual({ value: String(MIGRATIONS.length) });
		expect(f.sql.prepare("SELECT COUNT(*) AS n FROM topics").get()).toEqual({ n: 1 });
		expect(f.sql.prepare("SELECT COUNT(*) AS n FROM tokens").get()).toEqual({ n: 1 });
	});

	it("packs a topic's messages into one row per day and prunes whole expired days", async () => {
		const { d1, sql, stats } = await db();
		const day = 20_000 * 86400;
		const before = stats.writes;
		for (let i = 0; i < 5; i++) await insertMessage(d1, buildMessage("alerts", { body: `m${i}` }, day + i, 3600), day + i);
		// Each publish writes the day row and the topic counter row: two rows, no per-message rows.
		expect(stats.writes - before).toBe(10);
		await insertMessage(d1, buildMessage("alerts", { body: "tomorrow" }, day + 86400, 3600), day + 86400);
		expect(sql.prepare("SELECT day, count FROM inbox ORDER BY day").all()).toEqual([
			{ day: 20_000, count: 5 },
			{ day: 20_001, count: 1 },
		]);
		expect((await listMessages(d1, { topics: ["alerts"], now: day + 10, limit: 3 })).map((m) => m.body)).toEqual(["tomorrow", "m4", "m3"]);
		expect((await listMessages(d1, { topics: ["alerts"], now: day + 10, since: day + 2 })).map((m) => m.body)).toEqual(["tomorrow", "m4", "m3"]);
		expect(await pruneExpired(d1, day + 3600 + 10)).toBe(1);
		expect(sql.prepare("SELECT COUNT(*) AS n FROM inbox").get()).toEqual({ n: 1 });
	});

	it("keeps every device on a topic in one row, deduplicated by endpoint", async () => {
		const { d1, sql } = await db();
		for (let i = 0; i < 3; i++) expect(await addSubscription(d1, "alerts", sub(i))).toEqual({ created: true });
		expect(await addSubscription(d1, "alerts", { ...sub(1), p256dh: "new" })).toEqual({ created: false });
		const subs = await getSubscriptions(d1, "alerts");
		expect(subs.map((s) => s.endpoint)).toEqual([sub(0).endpoint, sub(1).endpoint, sub(2).endpoint]);
		expect(subs[1]).toMatchObject({ p256dh: "new", created_at: 1 });
		expect(sql.prepare("SELECT COUNT(*) AS n FROM push_subs").get()).toEqual({ n: 1 });
		expect(await removeSubscriptions(d1, "alerts", [sub(0).endpoint, "https://unknown.example.com/x"])).toBe(1);
		expect((await getSubscriptions(d1, "alerts")).length).toBe(2);
	});

	it("generates the VAPID key pair once per deployment", async () => {
		const { d1 } = await db();
		const a = await getVapidKeys(d1);
		resetSchemaFlag(); // a new isolate reads the stored pair
		const b = await getVapidKeys(d1);
		expect(b).toEqual(a);
		expect(a.privateJwk.d).toBeTruthy();
	});
});
