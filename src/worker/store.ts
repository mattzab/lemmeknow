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

// ---------- messages ----------

export const POLL_LIMIT = 1000;

interface MessageRow {
	seq: number;
	id: string;
	topic: string;
	time: number;
	expires: number;
	published: number;
	body: string;
}

const parse = (r: MessageRow): NtfyMessage => JSON.parse(r.body) as NtfyMessage;

export async function insertMessage(db: D1Database, m: NtfyMessage, published: boolean, now: number): Promise<void> {
	await db.batch([
		db
			.prepare("INSERT INTO messages (id, topic, time, expires, published, body) VALUES (?, ?, ?, ?, ?, ?)")
			.bind(m.id, m.topic, m.time, m.expires ?? m.time, published ? 1 : 0, JSON.stringify(m)),
		...(published ? [touchTopicStmt(db, m.topic, now)] : []),
	]);
}

export function touchTopicStmt(db: D1Database, topic: string, now: number): D1PreparedStatement {
	return db
		.prepare(
			"INSERT INTO topics (name, created_at, last_message_at, message_count) VALUES (?, ?, ?, 1) ON CONFLICT(name) DO UPDATE SET last_message_at = excluded.last_message_at, message_count = message_count + 1",
		)
		.bind(topic, now, now);
}

/**
 * Cached messages for `topics` newer than `since` (ntfy sendOldMessages), oldest first.
 * Expired messages are never returned; scheduled (not yet delivered) ones only if `scheduled`.
 */
export async function fetchCached(db: D1Database, topics: string[], since: Since, opts: { scheduled?: boolean; id?: string; now: number; limit?: number }): Promise<NtfyMessage[]> {
	if (since.kind === "none" || topics.length === 0) return [];
	const limit = opts.limit ?? POLL_LIMIT;
	const ph = topics.map(() => "?").join(",");
	const base = `topic IN (${ph}) AND expires > ?${opts.scheduled ? "" : " AND published = 1"}`;
	const args: unknown[] = [...topics, opts.now];

	if (opts.id) {
		// Single-message poll (the iOS app's `?poll=1&id=<poll_id>`).
		const { results } = await db.prepare(`SELECT * FROM messages WHERE id = ? AND ${base}`).bind(opts.id, ...args).all<MessageRow>();
		return results.map(parse);
	}
	if (since.kind === "latest") {
		const out: MessageRow[] = [];
		for (const t of topics) {
			const r = await db
				.prepare(`SELECT * FROM messages WHERE topic = ? AND expires > ?${opts.scheduled ? "" : " AND published = 1"} ORDER BY time DESC, seq DESC LIMIT 1`)
				.bind(t, opts.now)
				.first<MessageRow>();
			if (r) out.push(r);
		}
		return out.sort((a, b) => a.time - b.time || a.seq - b.seq).map(parse);
	}
	let where = base;
	if (since.kind === "time") {
		where += " AND time >= ?";
		args.push(since.time);
	} else if (since.kind === "id") {
		const marker = await db.prepare("SELECT time, seq FROM messages WHERE id = ?").bind(since.id).first<{ time: number; seq: number }>();
		if (marker) {
			where += " AND (time > ? OR (time = ? AND seq > ?))";
			args.push(marker.time, marker.time, marker.seq);
		}
	}
	const { results } = await db
		.prepare(`SELECT * FROM (SELECT * FROM messages WHERE ${where} ORDER BY time DESC, seq DESC LIMIT ?) ORDER BY time ASC, seq ASC`)
		.bind(...args, limit)
		.all<MessageRow>();
	return results.map(parse);
}

/** Claim scheduled messages that are due (atomically flips published), oldest first. */
export async function claimDueMessages(db: D1Database, now: number): Promise<NtfyMessage[]> {
	const { results } = await db.prepare("UPDATE messages SET published = 1 WHERE published = 0 AND time <= ? RETURNING *").bind(now).all<MessageRow>();
	if (results.length) await db.batch(results.map((r) => touchTopicStmt(db, r.topic, now)));
	return results.sort((a, b) => a.time - b.time || a.seq - b.seq).map(parse);
}

export async function pruneExpired(db: D1Database, now: number): Promise<number> {
	const r = await db.prepare("DELETE FROM messages WHERE expires <= ?").bind(now).run();
	return r.meta?.changes ?? 0;
}

export async function recentMessages(db: D1Database, opts: { topic?: string; limit: number; now: number }): Promise<(NtfyMessage & { published: boolean })[]> {
	const where = opts.topic ? "WHERE topic = ? AND expires > ?" : "WHERE expires > ?";
	const args: unknown[] = opts.topic ? [opts.topic, opts.now] : [opts.now];
	const { results } = await db.prepare(`SELECT * FROM messages ${where} ORDER BY time DESC, seq DESC LIMIT ?`).bind(...args, opts.limit).all<MessageRow>();
	return results.map((r) => ({ ...parse(r), published: r.published === 1 }));
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
			"SELECT t.*, (SELECT COUNT(*) FROM messages m WHERE m.topic = t.name AND m.expires > ?) AS cached FROM topics t ORDER BY COALESCE(t.last_message_at, t.created_at) DESC",
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
	await db.batch([db.prepare("DELETE FROM messages WHERE topic = ?").bind(name), db.prepare("DELETE FROM topics WHERE name = ?").bind(name)]);
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

export async function countMessages(db: D1Database, now: number): Promise<number> {
	const r = await db.prepare("SELECT COUNT(*) AS n FROM messages WHERE expires > ? AND published = 1").bind(now).first<{ n: number }>();
	return r?.n ?? 0;
}
