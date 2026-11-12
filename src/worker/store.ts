import type { Grant, NtfyMessage, TokenInfo, TopicInfo } from "@shared/types";
import type { Since } from "./ntfy/subscribe";

/** Ordered, idempotent migrations. Append only; never edit a shipped entry. */
export const MIGRATIONS: string[] = [
	`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topics (
  name TEXT PRIMARY KEY, description TEXT NOT NULL DEFAULT '',
  anon_read INTEGER NOT NULL DEFAULT 0, anon_write INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, last_message_at INTEGER, message_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, prefix TEXT NOT NULL,
  grants TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, last_used_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, topic TEXT NOT NULL,
  time INTEGER NOT NULL, expires INTEGER NOT NULL, published INTEGER NOT NULL DEFAULT 1, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic, time, seq);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires);
CREATE INDEX IF NOT EXISTS idx_messages_due ON messages(published, time)
`,
	// 2: pack the cache into one row per topic per UTC hour (see docs/DECISIONS.md), copy any
	// rows from the per-message table into buckets, then drop it. No secondary indexes on purpose:
	// D1 bills every index entry a write touches as an extra row written.
	`
CREATE TABLE IF NOT EXISTS buckets (
  topic TEXT NOT NULL, hour INTEGER NOT NULL, part INTEGER NOT NULL DEFAULT 0,
  entries TEXT NOT NULL DEFAULT '[]', published INTEGER NOT NULL DEFAULT 0,
  min_expires INTEGER NOT NULL, max_expires INTEGER NOT NULL, next_due INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (topic, hour, part)) WITHOUT ROWID;
INSERT OR IGNORE INTO buckets (topic, hour, part, entries, published, min_expires, max_expires, next_due, version)
  SELECT topic, time / 3600, 0, json_group_array(json_object('p', published, 's', seq, 'm', json(body))), SUM(published),
         MIN(expires), MAX(expires), MIN(CASE WHEN published = 0 THEN time END), 1
  FROM (SELECT * FROM messages ORDER BY time, seq) GROUP BY topic, time / 3600;
DROP TABLE IF EXISTS messages
`,
];

let migratedIsolate = false;

export async function ensureSchema(db: D1Database): Promise<void> {
	if (migratedIsolate) return;
	let version = 0;
	try {
		const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>();
		version = row ? Number(row.value) : 0;
	} catch {
		version = 0;
	}
	for (let i = version; i < MIGRATIONS.length; i++) {
		const stmts = MIGRATIONS[i]
			.split(";")
			.map((s) => s.trim())
			.filter(Boolean)
			.map((s) => db.prepare(s));
		stmts.push(
			db.prepare("INSERT INTO settings(key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(String(i + 1)),
		);
		try {
			await db.batch(stmts);
		} catch (e) {
			const row = await db.prepare("SELECT value FROM settings WHERE key = 'schema_version'").first<{ value: string }>().catch(() => null);
			if (Number(row?.value ?? 0) > i) continue;
			throw e;
		}
	}
	migratedIsolate = true;
}

/** For tests: forget that this isolate already migrated. */
export function resetSchemaFlag() {
	migratedIsolate = false;
}

// ---------- messages (packed: one row per topic per UTC hour) ----------
//
// D1 bills per row read and written, so the cache is packed like Richter's check history:
// `buckets` holds one row per (topic, UTC hour) with a JSON array of entries
// `{ p: published 0|1, s: order key, m: message }`. A publish is a single atomic UPSERT that
// appends to the hour's array (no read-modify-write, so concurrent publishes cannot clobber
// each other). The cron rewrites buckets with a compare-and-swap on `version`. Reads load the
// handful of bucket rows for the requested topics and filter in memory. See docs/DECISIONS.md.

export const POLL_LIMIT = 1000;
/** Start a new part for the hour once a bucket's JSON nears this size (D1 caps a row at 2 MB). */
export const MAX_BUCKET_BYTES = 1_500_000;
/** Expired entries may linger this long in a live bucket before the cron rewrites it. */
export const STRIP_SLACK_SECONDS = 600;
const MAX_PARTS = 64;
const CAS_RETRIES = 5;

export interface CacheEntry {
	p: 0 | 1;
	s: number;
	m: NtfyMessage;
}

interface BucketRow {
	topic: string;
	hour: number;
	part: number;
	entries: string;
	version: number;
}

export const hourOf = (t: number) => Math.floor(t / 3600);
const expiresOf = (m: NtfyMessage) => m.expires ?? m.time;

// Order key for messages that share a timestamp (ntfy uses time, then insertion order).
let lastSeq = 0;
function nextSeq(): number {
	lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
	return lastSeq;
}

const byOrder = (a: CacheEntry, b: CacheEntry) => a.m.time - b.m.time || a.s - b.s;

function bucketMeta(entries: CacheEntry[]) {
	let published = 0;
	let min = Infinity;
	let max = -Infinity;
	let due: number | null = null;
	for (const e of entries) {
		const x = expiresOf(e.m);
		if (x < min) min = x;
		if (x > max) max = x;
		if (e.p) published++;
		else if (due === null || e.m.time < due) due = e.m.time;
	}
	return { published, min_expires: min, max_expires: max, next_due: due };
}

function appendStmt(db: D1Database, m: NtfyMessage, published: boolean, part: number): D1PreparedStatement {
	const entry: CacheEntry = { p: published ? 1 : 0, s: nextSeq(), m };
	const x = expiresOf(m);
	return db
		.prepare(
			`INSERT INTO buckets (topic, hour, part, entries, published, min_expires, max_expires, next_due)
VALUES (?, ?, ?, json_array(json(?)), ?, ?, ?, ?)
ON CONFLICT (topic, hour, part) DO UPDATE SET
  entries = json_insert(buckets.entries, '$[#]', json(excluded.entries -> '$[0]')),
  published = buckets.published + excluded.published,
  min_expires = MIN(buckets.min_expires, excluded.min_expires),
  max_expires = MAX(buckets.max_expires, excluded.max_expires),
  next_due = CASE WHEN excluded.next_due IS NULL THEN buckets.next_due WHEN buckets.next_due IS NULL THEN excluded.next_due ELSE MIN(buckets.next_due, excluded.next_due) END,
  version = buckets.version + 1
WHERE length(buckets.entries) + length(excluded.entries) < ${MAX_BUCKET_BYTES}`,
		)
		.bind(m.topic, hourOf(m.time), part, JSON.stringify(entry), published ? 1 : 0, x, x, published ? null : m.time);
}

/** Append a message to its topic's hour bucket: one row written (plus the topic counter when published). */
export async function insertMessage(db: D1Database, m: NtfyMessage, published: boolean, now: number): Promise<void> {
	const [first] = await db.batch([appendStmt(db, m, published, 0), ...(published ? [touchTopicStmt(db, m.topic, now)] : [])]);
	if ((first.meta?.changes ?? 0) > 0) return;
	// Part 0 of this hour is full: spill into the next part that has room.
	for (let part = 1; part < MAX_PARTS; part++) {
		const r = await appendStmt(db, m, published, part).run();
		if ((r.meta?.changes ?? 0) > 0) return;
	}
	throw new Error(`message cache bucket for ${m.topic} is full`);
}

export function touchTopicStmt(db: D1Database, topic: string, now: number): D1PreparedStatement {
	return db
		.prepare(
			"INSERT INTO topics (name, created_at, last_message_at, message_count) VALUES (?, ?, ?, 1) ON CONFLICT(name) DO UPDATE SET last_message_at = excluded.last_message_at, message_count = message_count + 1",
		)
		.bind(topic, now, now);
}

/** Load bucket rows (oldest first) and flatten them into entries. */
async function loadEntries(db: D1Database, where: string, args: unknown[], order = "hour ASC, part ASC"): Promise<CacheEntry[]> {
	const { results } = await db.prepare(`SELECT topic, hour, part, entries, version FROM buckets WHERE ${where} ORDER BY ${order}`).bind(...args).all<BucketRow>();
	const out: CacheEntry[] = [];
	for (const r of results) for (const e of JSON.parse(r.entries) as CacheEntry[]) out.push(e);
	return out;
}

/**
 * Cached messages for `topics` newer than `since` (ntfy sendOldMessages), oldest first.
 * Expired messages are never returned; scheduled (not yet delivered) ones only if `scheduled`.
 * Reads only the requested topics' hour buckets (about one row per topic per cached hour).
 */
export async function fetchCached(db: D1Database, topics: string[], since: Since, opts: { scheduled?: boolean; id?: string; now: number; limit?: number }): Promise<NtfyMessage[]> {
	if (since.kind === "none" || topics.length === 0) return [];
	const limit = opts.limit ?? POLL_LIMIT;
	let where = `topic IN (${topics.map(() => "?").join(",")}) AND max_expires > ?`;
	const args: unknown[] = [...topics, opts.now];
	if (since.kind === "time" && !opts.id) {
		where += " AND hour >= ?";
		args.push(hourOf(since.time));
	}
	if (!opts.scheduled) {
		// Published messages never sit in a future hour.
		where += " AND hour <= ?";
		args.push(hourOf(opts.now));
	}
	const all = (await loadEntries(db, where, args)).sort(byOrder);
	const live = all.filter((e) => expiresOf(e.m) > opts.now && (opts.scheduled || e.p === 1));

	if (opts.id) return live.filter((e) => e.m.id === opts.id).map((e) => e.m); // the iOS `?poll=1&id=`
	let picked = live;
	if (since.kind === "latest") {
		const last = new Map<string, CacheEntry>();
		for (const e of live) last.set(e.m.topic, e);
		picked = [...last.values()].sort(byOrder);
	} else if (since.kind === "time") {
		picked = live.filter((e) => e.m.time >= since.time);
	} else if (since.kind === "id") {
		const marker = all.find((e) => e.m.id === since.id);
		if (marker) picked = live.filter((e) => byOrder(e, marker) > 0);
	}
	return picked.slice(-limit).map((e) => e.m);
}

/**
 * Rewrite one bucket with optimistic concurrency: re-read and retry if a publish appended in
 * between (every write bumps `version`). An empty result deletes the row.
 */
async function rewriteBucket(db: D1Database, key: { topic: string; hour: number; part: number }, edit: (entries: CacheEntry[]) => CacheEntry[] | null): Promise<void> {
	for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
		const row = await db.prepare("SELECT topic, hour, part, entries, version FROM buckets WHERE topic = ? AND hour = ? AND part = ?").bind(key.topic, key.hour, key.part).first<BucketRow>();
		if (!row) return;
		const next = edit(JSON.parse(row.entries) as CacheEntry[]);
		if (next === null) return; // nothing to change
		let r: D1Result;
		if (next.length === 0) {
			r = await db.prepare("DELETE FROM buckets WHERE topic = ? AND hour = ? AND part = ? AND version = ?").bind(key.topic, key.hour, key.part, row.version).run();
		} else {
			const meta = bucketMeta(next);
			r = await db
				.prepare("UPDATE buckets SET entries = ?, published = ?, min_expires = ?, max_expires = ?, next_due = ?, version = version + 1 WHERE topic = ? AND hour = ? AND part = ? AND version = ?")
				.bind(JSON.stringify(next), meta.published, meta.min_expires, meta.max_expires, meta.next_due, key.topic, key.hour, key.part, row.version)
				.run();
		}
		if ((r.meta?.changes ?? 0) > 0) return;
	}
	throw new Error(`bucket ${key.topic}/${key.hour}/${key.part} kept changing; will retry next cron`);
}

/** Claim scheduled messages that are due (flips `p` with a compare-and-swap, so exactly once), oldest first. */
export async function claimDueMessages(db: D1Database, now: number): Promise<NtfyMessage[]> {
	const { results } = await db.prepare("SELECT topic, hour, part FROM buckets WHERE next_due IS NOT NULL AND next_due <= ?").bind(now).all<{ topic: string; hour: number; part: number }>();
	const claimed: CacheEntry[] = [];
	for (const key of results) {
		let mine: CacheEntry[] = [];
		await rewriteBucket(db, key, (entries) => {
			mine = [];
			const next = entries.map((e) => {
				if (e.p === 0 && e.m.time <= now) {
					const flipped: CacheEntry = { ...e, p: 1 };
					mine.push(flipped);
					return flipped;
				}
				return e;
			});
			return mine.length ? next : null;
		});
		claimed.push(...mine);
	}
	if (claimed.length) await db.batch(claimed.map((e) => touchTopicStmt(db, e.m.topic, now)));
	return claimed.sort(byOrder).map((e) => e.m);
}

/**
 * Cron cleanup: delete hour buckets whose messages have all expired, and strip expired entries
 * from live buckets once they are STRIP_SLACK_SECONDS stale (reads already skip them). Returns
 * the number of messages removed.
 */
export async function pruneExpired(db: D1Database, now: number): Promise<number> {
	const { results } = await db
		.prepare("SELECT topic, hour, part, version, max_expires, json_array_length(entries) AS n FROM buckets WHERE min_expires <= ?")
		.bind(now)
		.all<{ topic: string; hour: number; part: number; version: number; max_expires: number; n: number }>();
	let removed = 0;
	for (const b of results) {
		if (b.max_expires <= now) {
			const r = await db.prepare("DELETE FROM buckets WHERE topic = ? AND hour = ? AND part = ? AND version = ?").bind(b.topic, b.hour, b.part, b.version).run();
			if ((r.meta?.changes ?? 0) > 0) {
				removed += b.n;
				continue;
			}
		}
		let stripped = 0;
		await rewriteBucket(db, b, (entries) => {
			stripped = 0;
			const keep = entries.filter((e) => expiresOf(e.m) > now);
			if (keep.length === entries.length) return null;
			// Only pay for a rewrite once the oldest expired entry is past the slack window.
			const oldest = Math.min(...entries.filter((e) => expiresOf(e.m) <= now).map((e) => expiresOf(e.m)));
			if (keep.length && oldest > now - STRIP_SLACK_SECONDS) return null;
			stripped = entries.length - keep.length;
			return keep;
		});
		removed += stripped;
	}
	return removed;
}

export async function recentMessages(db: D1Database, opts: { topic?: string; limit: number; now: number }): Promise<(NtfyMessage & { published: boolean })[]> {
	const where = opts.topic ? "topic = ? AND max_expires > ?" : "max_expires > ?";
	const args: unknown[] = opts.topic ? [opts.topic, opts.now] : [opts.now];
	const entries = await loadEntries(db, where, args);
	return entries
		.filter((e) => expiresOf(e.m) > opts.now)
		.sort((a, b) => byOrder(b, a))
		.slice(0, opts.limit)
		.map((e) => ({ ...e.m, published: e.p === 1 }));
}

// ---------- topics ----------

interface TopicRow {
	name: string;
	description: string;
	anon_read: number;
	anon_write: number;
	created_at: number;
	last_message_at: number | null;
	message_count: number;
	cached?: number;
}

const topicInfo = (r: TopicRow, subscribers = 0): TopicInfo => ({
	name: r.name,
	description: r.description,
	anon_read: !!r.anon_read,
	anon_write: !!r.anon_write,
	created_at: r.created_at,
	last_message_at: r.last_message_at,
	message_count: r.message_count,
	cached: r.cached ?? 0,
	subscribers,
});

export async function listTopics(db: D1Database, now: number, subscribers: Record<string, number> = {}): Promise<TopicInfo[]> {
	const { results } = await db
		.prepare(
			// `cached` sums the per-bucket counters (a few rows per topic); never a per-message scan.
			"SELECT t.*, (SELECT COALESCE(SUM(b.published), 0) FROM buckets b WHERE b.topic = t.name AND b.max_expires > ?) AS cached FROM topics t ORDER BY COALESCE(t.last_message_at, t.created_at) DESC",
		)
		.bind(now)
		.all<TopicRow>();
	return results.map((r) => topicInfo(r, subscribers[r.name] ?? 0));
}

export async function getTopic(db: D1Database, name: string): Promise<TopicInfo | null> {
	const r = await db.prepare("SELECT * FROM topics WHERE name = ?").bind(name).first<TopicRow>();
	return r ? topicInfo(r) : null;
}

export async function upsertTopic(db: D1Database, t: { name: string; description?: string; anon_read?: boolean; anon_write?: boolean }, now: number): Promise<void> {
	await db
		.prepare(
			"INSERT INTO topics (name, description, anon_read, anon_write, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, anon_read = excluded.anon_read, anon_write = excluded.anon_write",
		)
		.bind(t.name, t.description ?? "", t.anon_read ? 1 : 0, t.anon_write ? 1 : 0, now)
		.run();
}

export async function deleteTopic(db: D1Database, name: string): Promise<void> {
	await db.batch([db.prepare("DELETE FROM buckets WHERE topic = ?").bind(name), db.prepare("DELETE FROM topics WHERE name = ?").bind(name)]);
}

/** Anonymous permissions for the given topics (missing topics have none). */
export async function anonPermissions(db: D1Database, topics: string[]): Promise<Map<string, { read: boolean; write: boolean }>> {
	const out = new Map<string, { read: boolean; write: boolean }>();
	if (!topics.length) return out;
	const { results } = await db
		.prepare(`SELECT name, anon_read, anon_write FROM topics WHERE name IN (${topics.map(() => "?").join(",")})`)
		.bind(...topics)
		.all<{ name: string; anon_read: number; anon_write: number }>();
	for (const r of results) out.set(r.name, { read: !!r.anon_read, write: !!r.anon_write });
	return out;
}

// ---------- tokens ----------

export interface TokenRow {
	id: string;
	label: string;
	token_hash: string;
	prefix: string;
	grants: string;
	created_at: number;
	last_used_at: number | null;
	expires_at: number | null;
}

export const tokenInfo = (r: TokenRow): TokenInfo => ({
	id: r.id,
	label: r.label,
	prefix: r.prefix,
	grants: JSON.parse(r.grants) as Grant[],
	created_at: r.created_at,
	last_used_at: r.last_used_at,
	expires_at: r.expires_at,
});

export async function listTokens(db: D1Database): Promise<TokenInfo[]> {
	const { results } = await db.prepare("SELECT * FROM tokens ORDER BY created_at DESC").all<TokenRow>();
	return results.map(tokenInfo);
}

export async function findTokenByHash(db: D1Database, hash: string): Promise<TokenRow | null> {
	return db.prepare("SELECT * FROM tokens WHERE token_hash = ?").bind(hash).first<TokenRow>();
}

export async function insertToken(db: D1Database, row: TokenRow): Promise<void> {
	await db
		.prepare("INSERT INTO tokens (id, label, token_hash, prefix, grants, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
		.bind(row.id, row.label, row.token_hash, row.prefix, row.grants, row.created_at, row.last_used_at, row.expires_at)
		.run();
}

export async function updateToken(db: D1Database, id: string, patch: { label?: string; grants?: Grant[]; expires_at?: number | null }): Promise<boolean> {
	const sets: string[] = [];
	const args: unknown[] = [];
	if (patch.label !== undefined) (sets.push("label = ?"), args.push(patch.label));
	if (patch.grants !== undefined) (sets.push("grants = ?"), args.push(JSON.stringify(patch.grants)));
	if (patch.expires_at !== undefined) (sets.push("expires_at = ?"), args.push(patch.expires_at));
	if (!sets.length) return true;
	const r = await db.prepare(`UPDATE tokens SET ${sets.join(", ")} WHERE id = ?`).bind(...args, id).run();
	return (r.meta?.changes ?? 0) > 0;
}

export async function deleteToken(db: D1Database, id: string): Promise<boolean> {
	const r = await db.prepare("DELETE FROM tokens WHERE id = ?").bind(id).run();
	return (r.meta?.changes ?? 0) > 0;
}

export async function touchToken(db: D1Database, id: string, now: number): Promise<void> {
	await db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}

/** Cached message count from the bucket counters (expired entries count until the cron strips them). */
export async function countMessages(db: D1Database, now: number): Promise<number> {
	const r = await db.prepare("SELECT COALESCE(SUM(published), 0) AS n FROM buckets WHERE max_expires > ?").bind(now).first<{ n: number }>();
	return r?.n ?? 0;
}
