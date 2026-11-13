import type { Grant, Message, TokenInfo, TopicInfo } from "@shared/types";
import type { VapidKeys } from "./webpush";
import { generateVapidKeys } from "./webpush";

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
	// 3: re-key buckets from UTC hour to UTC day. Hour buckets are merged into day buckets in
	// (hour, part, position) order, keeping each entry (and its published flag) as is. A new part
	// starts whenever the hour buckets merged so far reach 400 KB, so a merged row stays under
	// 400 KB + one 1.5 MB hour bucket, inside D1's 2 MB row limit.
	`
CREATE TABLE IF NOT EXISTS buckets_v3 (
  topic TEXT NOT NULL, day INTEGER NOT NULL, part INTEGER NOT NULL DEFAULT 0,
  entries TEXT NOT NULL DEFAULT '[]', published INTEGER NOT NULL DEFAULT 0,
  min_expires INTEGER NOT NULL, max_expires INTEGER NOT NULL, next_due INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (topic, day, part)) WITHOUT ROWID;
INSERT OR IGNORE INTO buckets_v3 (topic, day, part, entries, published, min_expires, max_expires, next_due, version)
  SELECT topic, day, grp, json_group_array(json(e)), SUM(p), MIN(mn), MAX(mx), MIN(nd), 1
  FROM (
    SELECT b.topic AS topic, b.hour / 24 AS day, b.grp AS grp, j.value AS e, json_extract(j.value, '$.p') AS p,
           b.min_expires AS mn, b.max_expires AS mx, b.next_due AS nd
    FROM (SELECT *, (SUM(length(entries)) OVER (PARTITION BY topic, hour / 24 ORDER BY hour, part) - length(entries)) / 400000 AS grp FROM buckets) AS b,
         json_each(b.entries) AS j
    ORDER BY b.topic, b.hour / 24, b.grp, b.hour, b.part, j.key
  )
  GROUP BY topic, day, grp;
DROP TABLE buckets;
ALTER TABLE buckets_v3 RENAME TO buckets
`,
	// 4: Lemmeknow 0.2 drops the ntfy-format message cache. Messages now live in `inbox`
	// (still one packed row per topic per UTC day) and Web Push subscriptions in `push_subs`
	// (one packed row per topic). See docs/DECISIONS.md.
	`
DROP TABLE IF EXISTS buckets;
CREATE TABLE IF NOT EXISTS inbox (
  topic TEXT NOT NULL, day INTEGER NOT NULL, part INTEGER NOT NULL DEFAULT 0,
  entries TEXT NOT NULL DEFAULT '[]', count INTEGER NOT NULL DEFAULT 0, max_expires INTEGER NOT NULL,
  PRIMARY KEY (topic, day, part)) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS push_subs (
  topic TEXT PRIMARY KEY, subs TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1) WITHOUT ROWID
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


/** For tests: forget that this isolate already migrated (and any cached hints). */
export function resetSchemaFlag() {
	migratedIsolate = false;
	partHint.clear();
	vapidCache = null;
}

// ---------- settings: the deployment's VAPID key pair ----------

let vapidCache: VapidKeys | null = null;

/**
 * The VAPID key pair, generated on first use and stored in `settings` (one row, never in git or a
 * secret). Concurrent first calls race on INSERT OR IGNORE and everyone reads back the winner.
 * Rotating it invalidates every push subscription, so it is never regenerated once stored.
 */
export async function getVapidKeys(db: D1Database): Promise<VapidKeys> {
	if (vapidCache) return vapidCache;
	const read = () => db.prepare("SELECT value FROM settings WHERE key = 'vapid'").first<{ value: string }>();
	let row = await read();
	if (!row) {
		const fresh = await generateVapidKeys();
		await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)").bind(JSON.stringify(fresh)).run();
		row = await read();
	}
	if (!row) throw new Error("could not store VAPID keys");
	vapidCache = JSON.parse(row.value) as VapidKeys;
	return vapidCache;
}

// ---------- inbox (packed: one row per topic per UTC day) ----------
//
// D1 bills per row read and written, so messages are packed: `inbox` holds one row per
// (topic, UTC day) with a JSON array of `{ s: order key, m: message }`. A publish is a single
// atomic UPSERT that appends to the day's array (no read-modify-write, so concurrent publishes
// cannot clobber each other). Reads load a topic's few day rows and filter in memory. The cron
// deletes a day row once every message in it has expired.

/** Start a new part for the day once a row's JSON nears this size (D1 caps a row at 2 MB). */
export const MAX_BUCKET_BYTES = 1_500_000;
const MAX_PARTS = 256;
export const MAX_LIST = 500;

interface InboxEntry {
	s: number;
	m: Message;
}

export const dayOf = (t: number) => Math.floor(t / 86400);
const partHint = new Map<string, number>();

// Order key for messages that share a timestamp.
let lastSeq = 0;
function nextSeq(): number {
	lastSeq = Math.max(lastSeq + 1, Date.now() * 1000);
	return lastSeq;
}

function appendStmt(db: D1Database, m: Message, part: number): D1PreparedStatement {
	const entry: InboxEntry = { s: nextSeq(), m };
	return db
		.prepare(
			`INSERT INTO inbox (topic, day, part, entries, count, max_expires)
VALUES (?, ?, ?, json_array(json(?)), 1, ?)
ON CONFLICT (topic, day, part) DO UPDATE SET
  entries = json_insert(inbox.entries, '$[#]', json(excluded.entries -> '$[0]')),
  count = inbox.count + 1,
  max_expires = MAX(inbox.max_expires, excluded.max_expires)
WHERE length(inbox.entries) + length(excluded.entries) < ${MAX_BUCKET_BYTES}`,
		)
		.bind(m.topic, dayOf(m.time), part, JSON.stringify(entry), m.expires);
}

export function touchTopicStmt(db: D1Database, topic: string, now: number): D1PreparedStatement {
	return db
		.prepare(
			"INSERT INTO topics (name, created_at, last_message_at, message_count) VALUES (?, ?, ?, 1) ON CONFLICT(name) DO UPDATE SET last_message_at = excluded.last_message_at, message_count = message_count + 1",
		)
		.bind(topic, now, now);
}

/** Append a message to its topic's day row and bump the topic counters: two rows written, no reads. */
export async function insertMessage(db: D1Database, m: Message, now: number): Promise<void> {
	const key = `${m.topic}\u0000${dayOf(m.time)}`;
	const start = partHint.get(key) ?? 0;
	const [first] = await db.batch([appendStmt(db, m, start), touchTopicStmt(db, m.topic, now)]);
	if ((first.meta?.changes ?? 0) > 0) return;
	for (let part = start + 1; part < MAX_PARTS; part++) {
		const r = await appendStmt(db, m, part).run();
		if ((r.meta?.changes ?? 0) > 0) {
			if (partHint.size > 10_000) partHint.clear();
			partHint.set(key, part);
			return;
		}
	}
	throw new Error(`inbox for ${m.topic} is full today`);
}

/**
 * Unexpired messages, newest first. `topics` undefined means every topic (dashboard only).
 * `since` (Unix seconds) returns only messages strictly newer than that time.
 */
export async function listMessages(db: D1Database, opts: { topics?: string[]; since?: number; limit?: number; now: number }): Promise<Message[]> {
	const limit = Math.min(MAX_LIST, Math.max(1, opts.limit ?? 100));
	const where = ["max_expires > ?"];
	const args: unknown[] = [opts.now];
	if (opts.topics) {
		if (!opts.topics.length) return [];
		where.push(`topic IN (${opts.topics.map(() => "?").join(",")})`);
		args.push(...opts.topics);
	}
	if (opts.since) {
		where.push("day >= ?");
		args.push(dayOf(opts.since));
	}
	const { results } = await db.prepare(`SELECT entries FROM inbox WHERE ${where.join(" AND ")}`).bind(...args).all<{ entries: string }>();
	const all: InboxEntry[] = [];
	for (const r of results) {
		for (const e of JSON.parse(r.entries) as InboxEntry[]) {
			if (e.m.expires > opts.now && (!opts.since || e.m.time > opts.since)) all.push(e);
		}
	}
	all.sort((a, b) => b.m.time - a.m.time || b.s - a.s);
	return all.slice(0, limit).map((e) => e.m);
}

/** Cron: drop day rows whose messages have all expired. */
export async function pruneExpired(db: D1Database, now: number): Promise<number> {
	const r = await db.prepare("DELETE FROM inbox WHERE max_expires <= ?").bind(now).run();
	return r.meta?.changes ?? 0;
}

// ---------- push subscriptions (packed: one row per topic) ----------
//
// Publishing reads exactly one row to find every device on a topic. Writes (subscribe,
// unsubscribe, pruning dead endpoints) are a compare-and-swap on `version`, retried on conflict.

export interface StoredSub {
	/** Stable id: first 16 hex chars of sha256(endpoint). */
	id: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	created_at: number;
	/** Token the device subscribed with (null for public topics). Revoking it removes the device. */
	token_id: string | null;
}

/** ~400 bytes each, so a topic row stays far below D1's 2 MB row limit. */
export const MAX_SUBS_PER_TOPIC = 1000;
const CAS_RETRIES = 8;

export async function getSubscriptions(db: D1Database, topic: string): Promise<StoredSub[]> {
	const row = await db.prepare("SELECT subs FROM push_subs WHERE topic = ?").bind(topic).first<{ subs: string }>();
	return row ? (JSON.parse(row.subs) as StoredSub[]) : [];
}

/** Read-modify-write one topic's subscription list. `fn` returns null to leave it unchanged. */
async function mutateSubs(db: D1Database, topic: string, fn: (subs: StoredSub[]) => StoredSub[] | null): Promise<StoredSub[]> {
	for (let i = 0; i < CAS_RETRIES; i++) {
		const row = await db.prepare("SELECT subs, version FROM push_subs WHERE topic = ?").bind(topic).first<{ subs: string; version: number }>();
		const cur = row ? (JSON.parse(row.subs) as StoredSub[]) : [];
		const next = fn(cur);
		if (next === null) return cur;
		let r: D1Result;
		if (!row) {
			if (!next.length) return next;
			r = await db.prepare("INSERT INTO push_subs (topic, subs) VALUES (?, ?) ON CONFLICT(topic) DO NOTHING").bind(topic, JSON.stringify(next)).run();
		} else if (!next.length) {
			r = await db.prepare("DELETE FROM push_subs WHERE topic = ? AND version = ?").bind(topic, row.version).run();
		} else {
			r = await db.prepare("UPDATE push_subs SET subs = ?, version = version + 1 WHERE topic = ? AND version = ?").bind(JSON.stringify(next), topic, row.version).run();
		}
		if ((r.meta?.changes ?? 0) > 0) return next;
	}
	throw new Error(`push subscriptions for ${topic} are too contended`);
}

export class TooManySubscriptions extends Error {}

/** Add or refresh a device on a topic (same endpoint = same device; keys are replaced). */
export async function addSubscription(db: D1Database, topic: string, sub: StoredSub): Promise<{ created: boolean }> {
	let created = false;
	await mutateSubs(db, topic, (subs) => {
		const i = subs.findIndex((s) => s.endpoint === sub.endpoint);
		if (i >= 0) {
			created = false;
			const old = subs[i];
			if (old.p256dh === sub.p256dh && old.auth === sub.auth && old.token_id === sub.token_id) return null;
			const next = subs.slice();
			next[i] = { ...sub, created_at: old.created_at };
			return next;
		}
		if (subs.length >= MAX_SUBS_PER_TOPIC) throw new TooManySubscriptions(`A topic holds at most ${MAX_SUBS_PER_TOPIC} devices.`);
		created = true;
		return [...subs, sub];
	});
	return { created };
}

/** Remove the given endpoints from a topic. Returns how many were removed. */
export async function removeSubscriptions(db: D1Database, topic: string, endpoints: Iterable<string>): Promise<number> {
	const drop = new Set(endpoints);
	let removed = 0;
	await mutateSubs(db, topic, (subs) => {
		const next = subs.filter((s) => !drop.has(s.endpoint));
		removed = subs.length - next.length;
		return removed ? next : null;
	});
	return removed;
}

/** When a token is revoked, the devices that subscribed with it stop receiving pushes. */
export async function removeSubscriptionsByToken(db: D1Database, tokenId: string): Promise<number> {
	const { results } = await db.prepare("SELECT topic, subs FROM push_subs").all<{ topic: string; subs: string }>();
	let removed = 0;
	for (const r of results) {
		const subs = JSON.parse(r.subs) as StoredSub[];
		const gone = subs.filter((s) => s.token_id === tokenId).map((s) => s.endpoint);
		if (gone.length) removed += await removeSubscriptions(db, r.topic, gone);
	}
	return removed;
}

export async function subscriptionCounts(db: D1Database): Promise<Record<string, number>> {
	const { results } = await db.prepare("SELECT topic, json_array_length(subs) AS n FROM push_subs").all<{ topic: string; n: number }>();
	return Object.fromEntries(results.map((r) => [r.topic, r.n]));
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
	stored?: number;
}

const topicInfo = (r: TopicRow, devices = 0): TopicInfo => ({
	name: r.name,
	description: r.description,
	public_read: !!r.anon_read,
	public_write: !!r.anon_write,
	created_at: r.created_at,
	last_message_at: r.last_message_at,
	message_count: r.message_count,
	stored: r.stored ?? 0,
	devices,
});

export async function listTopics(db: D1Database, now: number): Promise<TopicInfo[]> {
	const [{ results }, devices] = await Promise.all([
		db
			.prepare(
				// `stored` sums per-day counters (a row or two per topic); never a per-message scan.
				"SELECT t.*, (SELECT COALESCE(SUM(b.count), 0) FROM inbox b WHERE b.topic = t.name AND b.max_expires > ?) AS stored FROM topics t ORDER BY COALESCE(t.last_message_at, t.created_at) DESC",
			)
			.bind(now)
			.all<TopicRow>(),
		subscriptionCounts(db),
	]);
	return results.map((r) => topicInfo(r, devices[r.name] ?? 0));
}

export async function getTopic(db: D1Database, name: string): Promise<TopicInfo | null> {
	const r = await db.prepare("SELECT * FROM topics WHERE name = ?").bind(name).first<TopicRow>();
	return r ? topicInfo(r) : null;
}

export async function upsertTopic(db: D1Database, t: { name: string; description?: string; public_read?: boolean; public_write?: boolean }, now: number): Promise<void> {
	await db
		.prepare(
			"INSERT INTO topics (name, description, anon_read, anon_write, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET description = excluded.description, anon_read = excluded.anon_read, anon_write = excluded.anon_write",
		)
		.bind(t.name, t.description ?? "", t.public_read ? 1 : 0, t.public_write ? 1 : 0, now)
		.run();
}

export async function deleteTopic(db: D1Database, name: string): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM inbox WHERE topic = ?").bind(name),
		db.prepare("DELETE FROM push_subs WHERE topic = ?").bind(name),
		db.prepare("DELETE FROM topics WHERE name = ?").bind(name),
	]);
}

/** Public permissions for a topic (unknown topics have none). */
export async function publicPermissions(db: D1Database, topic: string): Promise<{ read: boolean; write: boolean }> {
	const r = await db.prepare("SELECT anon_read, anon_write FROM topics WHERE name = ?").bind(topic).first<{ anon_read: number; anon_write: number }>();
	return { read: !!r?.anon_read, write: !!r?.anon_write };
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
