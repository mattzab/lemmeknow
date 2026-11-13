import type { Grant, MeInfo, Role } from "@shared/types";
import { authenticate, verifyTeamJwt } from "./access";
import { generateToken, grantsAllow, hashToken, TOKEN_PREFIX } from "./auth";
import type { Env } from "./env";
import {
	deleteToken,
	deleteUserRow,
	getEvalKey,
	getToken,
	getUser,
	insertPairCode,
	insertToken,
	listTopics,
	listUserRows,
	moveSubscriptions,
	personalToken,
	removeSubscriptionsByToken,
	type TokenRow,
	tokensOfUser,
	updateToken,
} from "./store";
import { b64url, nowSec, randomString, sha256Hex, utf8 } from "./util";

/**
 * People: who may sign in (Cloudflare Access email login) and what they may do.
 *   - Owners: emails in the ADMIN_EMAILS binding (adminEmails in lemmeknow.config.json). Always admins.
 *   - Invited users: rows in `users`, added from the dashboard, role admin or member.
 *   - Bootstrap: with no owners configured and nobody invited yet, any Access identity is an admin
 *     (the Access policy is then the only gate, as in 0.2). The first person to invite someone is
 *     recorded as an admin so the bootstrap ends.
 * Access lets invited people in through an External Evaluation rule that calls /access/evaluate.
 */

export interface Person {
	email: string;
	role: Role;
	grants: Grant[];
	/** Not stored anywhere yet (bootstrap admin). */
	bootstrap?: boolean;
}

export const normEmail = (e: string) => e.trim().toLowerCase();

export function configAdmins(env: Env): string[] {
	return (env.ADMIN_EMAILS ?? "")
		.split(/[\s,;]+/)
		.map(normEmail)
		.filter(Boolean);
}

export const ALL: Grant[] = [{ topic: "*", read: true, write: true }];

/** Resolve a verified Access email to a person, or null when they are not invited. */
export async function resolvePerson(env: Env, rawEmail: string): Promise<Person | null> {
	const email = normEmail(rawEmail);
	const owners = configAdmins(env);
	if (owners.includes(email)) return { email, role: "admin", grants: ALL };
	const row = await getUser(env.DB, email);
	if (row) return { email, role: row.role, grants: row.role === "admin" ? ALL : (JSON.parse(row.grants) as Grant[]) };
	if (!owners.length && !(await listUserRows(env.DB)).length) return { email, role: "admin", grants: ALL, bootstrap: true };
	return null;
}

/** Verify the request's Access JWT and resolve the person (null: not signed in or not invited). */
export async function personFromRequest(req: Request, env: Env): Promise<{ person: Person | null; email: string | null }> {
	const id = await authenticate(req, env);
	if (!id) return { person: null, email: null };
	return { person: await resolvePerson(env, id.email), email: id.email };
}

export async function mintToken(env: Env, t: { label: string; grants: Grant[]; user_email?: string | null; personal?: boolean }): Promise<TokenRow> {
	const token = generateToken();
	const row: TokenRow = {
		id: randomString(16),
		label: t.label,
		token_hash: await hashToken(token),
		prefix: token.slice(0, TOKEN_PREFIX.length + 4),
		grants: JSON.stringify(t.grants),
		created_at: nowSec(),
		last_used_at: null,
		expires_at: null,
		token,
		user_email: t.user_email ?? null,
		personal: t.personal ? 1 : 0,
	};
	await insertToken(env.DB, row);
	return row;
}

/** A person's personal token, created on first use and kept in step with their grants. */
export async function ensurePersonalToken(env: Env, p: Person): Promise<TokenRow> {
	const cur = await personalToken(env.DB, p.email);
	if (!cur) return mintToken(env, { label: `${p.email} (personal)`, grants: p.grants, user_email: p.email, personal: true });
	if (cur.grants !== JSON.stringify(p.grants)) {
		await updateToken(env.DB, cur.id, { grants: p.grants });
		cur.grants = JSON.stringify(p.grants);
	}
	return cur;
}

/** What the web app shows a signed-in person: their permanent token and the topics they can use. */
export async function meInfo(env: Env, p: Person): Promise<MeInfo> {
	const tok = await ensurePersonalToken(env, p);
	const topics = (await listTopics(env.DB, nowSec()))
		.filter((t) => t.public_read || grantsAllow(p.grants, t.name, "read"))
		.map((t) => ({ name: t.name, description: t.description, can_write: t.public_write || grantsAllow(p.grants, t.name, "write") }));
	return { email: p.email, role: p.role, token: tok.token ?? "", grants: p.grants, topics };
}

/** Issue a new value for a token (same label, grants, owner); devices that used the old one keep working. */
export async function replaceToken(env: Env, id: string): Promise<TokenRow | null> {
	const old = await getToken(env.DB, id);
	if (!old) return null;
	const next = await mintToken(env, { label: old.label, grants: JSON.parse(old.grants) as Grant[], user_email: old.user_email, personal: !!old.personal });
	await moveSubscriptions(env.DB, old.id, next.id);
	await deleteToken(env.DB, old.id);
	return next;
}

/** Remove an invited user: their login (D1 is what Access's External Evaluation checks), tokens and devices. */
export async function removePerson(env: Env, email: string): Promise<{ tokens: number; devices: number }> {
	const tokens = await tokensOfUser(env.DB, email);
	let devices = 0;
	for (const t of tokens) {
		await deleteToken(env.DB, t.id);
		devices += await removeSubscriptionsByToken(env.DB, t.id);
	}
	await deleteUserRow(env.DB, email);
	return { tokens: tokens.length, devices };
}

// ---------- Safari → Home Screen pairing ----------

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
export const PAIR_TTL = 600;

export const normCode = (c: string) => c.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** A one-time code (10 minutes) that signs the Home Screen app in as this person. */
export async function createPairCode(env: Env, email: string): Promise<{ code: string; expires_at: number }> {
	const raw = randomString(8, CODE_ALPHABET);
	const expires_at = nowSec() + PAIR_TTL;
	await insertPairCode(env.DB, await sha256Hex(raw), email, expires_at);
	return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expires_at };
}

// ---------- Cloudflare Access External Evaluation ----------

export async function evalKeys(env: Env) {
	const k = await getEvalKey(env.DB);
	// Same shape as Cloudflare's reference Worker (workers-access-external-auth-example).
	return { keys: [{ kid: k.kid, ...k.publicJwk }] };
}

async function signEval(env: Env, payload: Record<string, unknown>): Promise<string> {
	const k = await getEvalKey(env.DB);
	const key = await crypto.subtle.importKey("jwk", k.privateJwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
	const head = b64url(utf8(JSON.stringify({ alg: "RS256", kid: k.kid, typ: "JWT" })));
	const body = b64url(utf8(JSON.stringify(payload)));
	const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, utf8(`${head}.${body}`));
	return `${head}.${body}.${b64url(sig)}`;
}

export type EvalVerifier = (token: string) => Promise<{ nonce?: string; identity?: { email?: string } }>;

/**
 * Access posts `{ token }` (a JWT signed by the team key, with `identity` and `nonce`) after the
 * person proves their email. Answer with a JWT signed by our key: `{ success, nonce, iat, exp }`.
 * success = the email is an owner or an invited user.
 */
export async function evaluateAccess(env: Env, body: unknown, verify?: EvalVerifier): Promise<{ token: string; success: boolean; email: string | null }> {
	const token = (body as { token?: unknown } | null)?.token;
	if (typeof token !== "string") throw new Error("missing token");
	const claims = verify ? await verify(token) : await verifyTeamJwt(token, env.ACCESS_TEAM_DOMAIN);
	const email = (claims as { identity?: { email?: string } }).identity?.email ?? null;
	const person = email ? await resolvePerson(env, email) : null;
	// Bootstrap admins are not invited by anyone: only the Access policy's own rules should admit them.
	const success = !!person && !person.bootstrap;
	const now = nowSec();
	return { token: await signEval(env, { success, nonce: (claims as { nonce?: string }).nonce, iat: now, exp: now + 60 }), success, email };
}
