import { describe, expect, it } from "vitest";
import type { NtfyMessage } from "../src/shared/types";
import { newMessage } from "../src/worker/ntfy/message";
import {
	MAX_BUCKET_BYTES,
	MIGRATIONS,
	STRIP_SLACK_SECONDS,
	countMessages,
	ensureSchema,
	fetchCached,
	insertMessage,
	listTopics,
	pruneExpired,
	recentMessages,
	resetSchemaFlag,
} from "../src/worker/store";
import { fakeD1 } from "./fake-d1";
import { fakeEnv } from "./helpers";

const NOW = 1_800_000_000; // exactly on an hour boundary
const msg = (topic: string, time: number, extra: Partial<NtfyMessage> = {}): NtfyMessage => ({ ...newMessage("message", topic, "hello", time), expires: time + 3600, ...extra });
const bucketCount = (sql: { prepare: (q: string) => { get: () => unknown } }) => (sql.prepare("SELECT COUNT(*) AS n FROM buckets").get() as { n: number }).n;

describe("packed message cache", () => {
	it("stores one row per topic per hour, not one per message", async () => {
		const f = await fakeEnv();
		for (let i = 0; i < 50; i++) await insertMessage(f.env.DB, msg("a", NOW + i * 10, { expires: NOW + 43200 }), true, NOW);
		for (let i = 0; i < 5; i++) await insertMessage(f.env.DB, msg("a", NOW + 3600 + i, { expires: NOW + 43200 }), true, NOW);
		await insertMessage(f.env.DB, msg("b", NOW + 5), true, NOW);
		expect(bucketCount(f.sql)).toBe(3);
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW + 3700 })).toHaveLength(55);
	});

	it("a publish writes exactly one bucket row plus the topic counter, with no reads", async () => {
		const { db, stats } = fakeD1();
		resetSchemaFlag();
		await ensureSchema(db as unknown as D1Database);
		await insertMessage(db as unknown as D1Database, msg("a", NOW), true, NOW);
		stats.writes = 0;
		stats.statements.length = 0;
		await insertMessage(db as unknown as D1Database, msg("a", NOW + 1), true, NOW);
		expect(stats.writes).toBe(2);
		expect(stats.statements.filter((q) => /^\s*SELECT/i.test(q))).toHaveLength(0);
	});

	it("concurrent publishes to the same topic never clobber each other", async () => {
		const f = await fakeEnv();
		await Promise.all(Array.from({ length: 40 }, (_, i) => insertMessage(f.env.DB, msg("a", NOW + (i % 3)), true, NOW)));
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW + 10 })).toHaveLength(40);
		const [t] = await listTopics(f.env.DB, NOW + 10);
		expect(t).toMatchObject({ name: "a", message_count: 40, cached: 40 });
		expect(await countMessages(f.env.DB, NOW + 10)).toBe(40);
	});

	it("poll by id reads only the topic's buckets", async () => {
		const f = await fakeEnv();
		const target = msg("a", NOW + 1);
		await insertMessage(f.env.DB, target, true, NOW);
		for (let i = 0; i < 20; i++) await insertMessage(f.env.DB, msg(`t${i}`, NOW), true, NOW);
		const rows = f.sql.prepare("SELECT COUNT(*) AS n FROM buckets WHERE topic = 'a'").get() as { n: number };
		expect(rows.n).toBe(1);
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW + 2, id: target.id })).toEqual([target]);
	});

	it("spills into a new part when an hour's bucket gets large", async () => {
		const f = await fakeEnv();
		const big = "x".repeat(4000);
		const n = Math.ceil(MAX_BUCKET_BYTES / 4000) + 20;
		for (let i = 0; i < n; i++) await insertMessage(f.env.DB, msg("a", NOW + (i % 3000), { message: big }), true, NOW);
		expect(bucketCount(f.sql)).toBeGreaterThan(1);
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW, limit: 10_000 })).toHaveLength(n);
	});

	it("prunes whole expired buckets and strips stale entries only after the slack window", async () => {
		const f = await fakeEnv();
		await insertMessage(f.env.DB, msg("a", NOW - 7200, { expires: NOW - 3600 }), true, NOW); // old hour: fully expired
		const early = msg("a", NOW + 10, { expires: NOW + 100 });
		const keep = msg("a", NOW + 20, { expires: NOW + 5000 });
		await insertMessage(f.env.DB, early, true, NOW);
		await insertMessage(f.env.DB, keep, true, NOW);
		expect(await pruneExpired(f.env.DB, NOW)).toBe(1);
		expect(bucketCount(f.sql)).toBe(1);
		// `early` expired, but within the slack it is filtered on read, not rewritten.
		expect(await pruneExpired(f.env.DB, NOW + 101)).toBe(0);
		expect((await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW + 101 })).map((m) => m.id)).toEqual([keep.id]);
		expect(await pruneExpired(f.env.DB, NOW + 100 + STRIP_SLACK_SECONDS + 1)).toBe(1);
		expect((await recentMessages(f.env.DB, { limit: 10, now: NOW + 800 })).map((m) => m.id)).toEqual([keep.id]);
	});
});

describe("migration from the per-message table", () => {
	it("copies old rows into hour buckets and drops the old table", async () => {
		const { db, sql } = fakeD1();
		const d1 = db as unknown as D1Database;
		// Simulate the first deploy: only migration 1 applied, with messages in the old table.
		for (const s of MIGRATIONS[0].split(";").map((x) => x.trim()).filter(Boolean)) sql.exec(s);
		sql.exec("INSERT INTO settings (key, value) VALUES ('schema_version', '1')");
		const a1 = msg("a", NOW + 5);
		const a2 = msg("a", NOW + 5);
		const b1 = msg("b", NOW + 3700);
		const later = msg("a", NOW + 7300);
		const ins = sql.prepare("INSERT INTO messages (id, topic, time, expires, published, body) VALUES (?, ?, ?, ?, ?, ?)");
		for (const [m, p] of [[a1, 1], [a2, 1], [b1, 1], [later, 0]] as const) ins.run(m.id, m.topic, m.time, m.expires!, p, JSON.stringify(m));

		resetSchemaFlag();
		await ensureSchema(d1);
		expect(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'messages'").get()).toBeUndefined();
		expect(bucketCount(sql)).toBe(3);
		expect((await fetchCached(d1, ["a", "b"], { kind: "all" }, { now: NOW + 3600 })).map((m) => m.id)).toEqual([a1.id, a2.id, b1.id]);
		expect((await fetchCached(d1, ["a"], { kind: "id", id: a1.id }, { now: NOW + 10 })).map((m) => m.id)).toEqual([a2.id]);
		expect((await fetchCached(d1, ["a"], { kind: "all" }, { now: NOW + 10, scheduled: true })).map((m) => m.id)).toContain(later.id);
		// New publishes land after migrated ones that share a timestamp.
		const a3 = msg("a", NOW + 5);
		await insertMessage(d1, a3, true, NOW);
		expect((await fetchCached(d1, ["a"], { kind: "all" }, { now: NOW + 10 })).map((m) => m.id)).toEqual([a1.id, a2.id, a3.id]);
	});
});
