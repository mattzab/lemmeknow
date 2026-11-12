import { describe, expect, it } from "vitest";
import type { NtfyMessage } from "../src/shared/types";
import { newMessage } from "../src/worker/ntfy/message";
import {
	MAX_BUCKET_BYTES,
	MIGRATIONS,
	claimDueMessages,
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

const NOW = 1_800_057_600; // exactly on a UTC day boundary
const DAY = 86400;
const msg = (topic: string, time: number, extra: Partial<NtfyMessage> = {}): NtfyMessage => ({ ...newMessage("message", topic, "hello", time), expires: time + 3600, ...extra });
const bucketCount = (sql: { prepare: (q: string) => { get: () => unknown } }) => (sql.prepare("SELECT COUNT(*) AS n FROM buckets").get() as { n: number }).n;

describe("packed message cache", () => {
	it("stores one row per topic per UTC day, not one per message", async () => {
		const f = await fakeEnv();
		for (let i = 0; i < 50; i++) await insertMessage(f.env.DB, msg("a", NOW + i * 10, { expires: NOW + DAY * 2 }), true, NOW);
		for (let i = 0; i < 5; i++) await insertMessage(f.env.DB, msg("a", NOW + 3600 * 13 + i, { expires: NOW + DAY * 2 }), true, NOW); // same day
		for (let i = 0; i < 5; i++) await insertMessage(f.env.DB, msg("a", NOW + DAY + i, { expires: NOW + DAY * 2 }), true, NOW); // next day
		await insertMessage(f.env.DB, msg("b", NOW + 5), true, NOW);
		expect(bucketCount(f.sql)).toBe(3); // a/day0, a/day1, b/day0
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW + DAY + 10 })).toHaveLength(60);
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW + 3600 * 13 + 10 })).toHaveLength(55);
		// since=<time> narrows to the days it can touch.
		expect(await fetchCached(f.env.DB, ["a"], { kind: "time", time: NOW + DAY }, { now: NOW + DAY + 10 })).toHaveLength(5);
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

	it("spills into a new part when a day's bucket gets large", async () => {
		const f = await fakeEnv();
		const big = "x".repeat(4000);
		const n = Math.ceil(MAX_BUCKET_BYTES / 4000) + 20;
		for (let i = 0; i < n; i++) await insertMessage(f.env.DB, msg("a", NOW + (i % 3000), { message: big }), true, NOW);
		expect(bucketCount(f.sql)).toBeGreaterThan(1);
		expect(await fetchCached(f.env.DB, ["a"], { kind: "all" }, { now: NOW, limit: 10_000 })).toHaveLength(n);
	});

	it("prunes whole expired buckets and strips stale entries only after the slack window", async () => {
		const f = await fakeEnv();
		await insertMessage(f.env.DB, msg("a", NOW - 7200, { expires: NOW - 3600 }), true, NOW); // previous day: fully expired
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
	it("copies old rows into day buckets and drops the old table", async () => {
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
		expect(bucketCount(sql)).toBe(2); // a/day0 (incl. the scheduled one), b/day0
		expect((await fetchCached(d1, ["a", "b"], { kind: "all" }, { now: NOW + 3600 })).map((m) => m.id)).toEqual([a1.id, a2.id, b1.id]);
		expect((await fetchCached(d1, ["a"], { kind: "id", id: a1.id }, { now: NOW + 10 })).map((m) => m.id)).toEqual([a2.id]);
		expect((await fetchCached(d1, ["a"], { kind: "all" }, { now: NOW + 10, scheduled: true })).map((m) => m.id)).toContain(later.id);
		// New publishes land after migrated ones that share a timestamp.
		const a3 = msg("a", NOW + 5);
		await insertMessage(d1, a3, true, NOW);
		expect((await fetchCached(d1, ["a"], { kind: "all" }, { now: NOW + 10 })).map((m) => m.id)).toEqual([a1.id, a2.id, a3.id]);
	});
});

describe("migration from hour buckets to day buckets", () => {
	it("merges hour buckets into day buckets, keeping order and published flags", async () => {
		const { db, sql } = fakeD1();
		const d1 = db as unknown as D1Database;
		// Simulate the hour-bucket release: migrations 1 and 2 applied.
		for (const m of MIGRATIONS.slice(0, 2)) for (const s of m.split(";").map((x) => x.trim()).filter(Boolean)) sql.exec(s);
		sql.exec("INSERT INTO settings (key, value) VALUES ('schema_version', '2')");
		const H = 3600;
		const day0 = Math.floor(NOW / DAY);
		const put = sql.prepare(
			"INSERT INTO buckets (topic, hour, part, entries, published, min_expires, max_expires, next_due, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 3)",
		);
		const e = (m: NtfyMessage, p: 0 | 1, s: number) => ({ p, s, m });
		const a1 = msg("a", NOW + 10, { expires: NOW + DAY });
		const a2 = msg("a", NOW + 10, { expires: NOW + DAY });
		const a3 = msg("a", NOW + 2 * H, { expires: NOW + DAY });
		const a4 = msg("a", NOW + 2 * H + 1, { expires: NOW + DAY });
		const due = msg("a", NOW + 5 * H, { expires: NOW + DAY });
		const nextDay = msg("a", NOW + DAY + 60, { expires: NOW + 2 * DAY });
		const b1 = msg("b", NOW + 3 * H, { expires: NOW + DAY });
		const row = (topic: string, hour: number, part: number, list: { p: 0 | 1; s: number; m: NtfyMessage }[]) => {
			const pending = list.filter((x) => !x.p).map((x) => x.m.time);
			put.run(topic, hour, part, JSON.stringify(list), list.filter((x) => x.p).length, Math.min(...list.map((x) => x.m.expires!)), Math.max(...list.map((x) => x.m.expires!)), pending.length ? Math.min(...pending) : null);
		};
		// Insert out of order, with an hour split across two parts.
		row("a", day0 * 24 + 2, 1, [e(a4, 1, 4)]);
		row("a", day0 * 24 + 0, 0, [e(a1, 1, 1), e(a2, 1, 2)]);
		row("a", day0 * 24 + 2, 0, [e(a3, 1, 3)]);
		row("a", day0 * 24 + 5, 0, [e(due, 0, 5)]);
		row("a", (day0 + 1) * 24, 0, [e(nextDay, 1, 6)]);
		row("b", day0 * 24 + 3, 0, [e(b1, 1, 7)]);

		resetSchemaFlag();
		await ensureSchema(d1);
		const rows = sql.prepare("SELECT topic, day, part, published, next_due, json_array_length(entries) AS n FROM buckets ORDER BY topic, day, part").all();
		expect(rows).toEqual([
			{ topic: "a", day: day0, part: 0, published: 4, next_due: due.time, n: 5 },
			{ topic: "a", day: day0 + 1, part: 0, published: 1, next_due: null, n: 1 },
			{ topic: "b", day: day0, part: 0, published: 1, next_due: null, n: 1 },
		]);
		expect(sql.prepare("SELECT name FROM sqlite_master WHERE name = 'buckets_v3'").get()).toBeUndefined();
		const now = NOW + 6 * H;
		expect((await fetchCached(d1, ["a"], { kind: "all" }, { now })).map((m) => m.id)).toEqual([a1.id, a2.id, a3.id, a4.id]);
		expect((await fetchCached(d1, ["a"], { kind: "all" }, { now, scheduled: true })).map((m) => m.id)).toEqual([a1.id, a2.id, a3.id, a4.id, due.id, nextDay.id]);
		// The scheduled entry is still pending and is claimed exactly once.
		expect((await claimDueMessages(d1, now)).map((m) => m.id)).toEqual([due.id]);
		expect(await claimDueMessages(d1, now)).toEqual([]);
		// New publishes append to the day bucket, after migrated entries.
		const a5 = msg("a", now, { expires: NOW + DAY });
		await insertMessage(d1, a5, true, now);
		expect((sql.prepare("SELECT COUNT(*) AS n FROM buckets WHERE topic = 'a'").get() as { n: number }).n).toBe(2);
		expect((await fetchCached(d1, ["a"], { kind: "latest" }, { now })).map((m) => m.id)).toEqual([a5.id]);
	});

	it("splits a merged day that would exceed the row size limit into parts", async () => {
		const { db, sql } = fakeD1();
		const d1 = db as unknown as D1Database;
		for (const m of MIGRATIONS.slice(0, 2)) for (const s of m.split(";").map((x) => x.trim()).filter(Boolean)) sql.exec(s);
		sql.exec("INSERT INTO settings (key, value) VALUES ('schema_version', '2')");
		const day0 = Math.floor(NOW / DAY);
		const put = sql.prepare("INSERT INTO buckets (topic, hour, part, entries, published, min_expires, max_expires, next_due) VALUES ('a', ?, 0, ?, ?, ?, ?, NULL)");
		const big = "x".repeat(3000);
		let total = 0;
		for (let h = 0; h < 12; h++) {
			const list = Array.from({ length: 300 }, (_, i) => ({ p: 1, s: h * 1000 + i, m: msg("a", NOW + h * 3600 + i, { expires: NOW + DAY, message: big }) }));
			total += list.length;
			put.run(day0 * 24 + h, JSON.stringify(list), list.length, NOW + DAY, NOW + DAY); // ~1 MB per hour
		}
		resetSchemaFlag();
		await ensureSchema(d1);
		const parts = sql.prepare("SELECT part, length(entries) AS len FROM buckets ORDER BY part").all() as { part: number; len: number }[];
		expect(parts.length).toBeGreaterThan(1);
		for (const p of parts) expect(p.len).toBeLessThan(2_000_000);
		const all = await fetchCached(d1, ["a"], { kind: "all" }, { now: NOW + 12 * 3600, limit: 100_000 });
		expect(all).toHaveLength(total);
		expect(all.map((m) => m.time)).toEqual([...all.map((m) => m.time)].sort((x, y) => x - y));
	});
});
