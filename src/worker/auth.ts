import type { Grant } from "@shared/types";
import { E } from "./ntfy/errors";
import { b64urlDecode, randomString, sha256Hex } from "./ntfy/util";
import { anonPermissions, findTokenByHash, touchToken } from "./store";

/**
 * ntfy-compatible credentials. Lemmeknow has no user accounts: every credential is an access token
 * with explicit per-topic read/write grants, minted in the (Access-protected) dashboard.
 *
 * Accepted forms (same places ntfy reads them):
 *   Authorization: Bearer tk_...
 *   Authorization: Basic base64(<any username>:tk_...)   the official apps' "user" login
 *   ?auth=<base64url("Bearer tk_..." or "Basic ...")>    for clients that cannot set headers
 */

export type Permission = "read" | "write";

export type Credential = { kind: "none" } | { kind: "invalid" } | { kind: "token"; token: string };

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const TOKEN_PREFIX = "tk_";

/** Same shape as ntfy tokens: "tk_" + 29 lowercase alphanumerics. */
export function generateToken(): string {
	return TOKEN_PREFIX + randomString(29, TOKEN_ALPHABET);
}

export const hashToken = (token: string) => sha256Hex(token);

/** Read the raw Authorization value from the header or the ?auth= / ?authorization= query param. */
export function readAuthValue(req: Request): string | null {
	let value = (req.headers.get("authorization") ?? "").trim();
	const q = new URL(req.url).searchParams;
	const qp = (q.get("authorization") ?? q.get("auth") ?? "").trim();
	if (qp) {
		try {
			value = b64urlDecode(qp).trim();
		} catch {
			return null;
		}
	}
	return value;
}

export function parseCredential(value: string | null): Credential {
	if (value === null) return { kind: "invalid" };
	if (!value) return { kind: "none" };
	const lower = value.toLowerCase();
	if (lower.startsWith("bearer ")) {
		const token = value.slice(7).trim();
		return token ? { kind: "token", token } : { kind: "invalid" };
	}
	if (lower.startsWith("basic ")) {
		let decoded: string;
		try {
			decoded = new TextDecoder().decode(Uint8Array.from(atob(value.slice(6).trim()), (c) => c.charCodeAt(0)));
		} catch {
			return { kind: "invalid" };
		}
		const i = decoded.indexOf(":");
		if (i < 0) return { kind: "invalid" };
		const password = decoded.slice(i + 1);
		// The username is ignored: the password is the token (ntfy also treats an empty
		// username's password as a token). This lets the official apps "log in" with a token.
		return password ? { kind: "token", token: password } : { kind: "invalid" };
	}
	// ntfy ignores other schemes (e.g. "vapid", "WebPush") and treats the request as anonymous.
	return { kind: "none" };
}

/** `*` matches any run of characters; everything else is literal. Topic names are case-sensitive. */
export function matchTopicPattern(pattern: string, topic: string): boolean {
	const re = new RegExp("^" + pattern.split("*").map(escapeRe).join(".*") + "$");
	return re.test(topic);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function grantsAllow(grants: Grant[], topic: string, perm: Permission): boolean {
	return grants.some((g) => g[perm] && matchTopicPattern(g.topic, topic));
}

export interface AuthResult {
	tokenId: string | null;
}

/**
 * Authorize `perm` on every topic, or throw an ntfy error:
 *   bad or unknown credentials → 401; anonymous or token without the grant → 403.
 */
export async function authorize(db: D1Database, req: Request, topics: string[], perm: Permission, now: number, waitUntil?: (p: Promise<unknown>) => void): Promise<AuthResult> {
	const cred = parseCredential(readAuthValue(req));
	if (cred.kind === "invalid") throw E.unauthorized;
	if (cred.kind === "none") {
		const anon = await anonPermissions(db, topics);
		if (topics.every((t) => anon.get(t)?.[perm])) return { tokenId: null };
		throw E.forbidden;
	}
	const row = await findTokenByHash(db, await hashToken(cred.token));
	if (!row || (row.expires_at && row.expires_at <= now)) throw E.unauthorized;
	const grants = JSON.parse(row.grants) as Grant[];
	if (!topics.every((t) => grantsAllow(grants, t, perm))) {
		const anon = await anonPermissions(db, topics);
		if (!topics.every((t) => grantsAllow(grants, t, perm) || anon.get(t)?.[perm])) throw E.forbidden;
	}
	// last_used_at is informational; write it at most every 5 minutes.
	if (!row.last_used_at || now - row.last_used_at > 300) {
		const p = touchToken(db, row.id, now).catch(() => {});
		if (waitUntil) waitUntil(p);
	}
	return { tokenId: row.id };
}
