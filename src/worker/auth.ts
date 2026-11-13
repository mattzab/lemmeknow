import type { Grant } from "@shared/types";
import { randomString, sha256Hex } from "./util";
import { findTokenByHash, publicPermissions, touchToken } from "./store";

/**
 * API credentials. Lemmeknow has no user accounts: every credential is an access token with
 * explicit per-topic read/write grants, minted in the (Access-protected) dashboard. Only the
 * SHA-256 of a token is stored. Send it as `Authorization: Bearer lk_...`.
 */

export type Permission = "read" | "write";

const TOKEN_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
export const TOKEN_PREFIX = "lk_";

/** "lk_" + 32 lowercase alphanumerics (~165 bits from Web Crypto). */
export function generateToken(): string {
	return TOKEN_PREFIX + randomString(32, TOKEN_ALPHABET);
}

export const hashToken = (token: string) => sha256Hex(token);

export class AuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
	}
}

/** The bearer token from the Authorization header: null when absent, throws when malformed. */
export function bearerToken(req: Request): string | null {
	const value = (req.headers.get("authorization") ?? "").trim();
	if (!value) return null;
	const m = /^bearer\s+(\S+)$/i.exec(value);
	if (!m) throw new AuthError(401, "Use Authorization: Bearer <token>.");
	return m[1];
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
 * Authorize `perm` on `topic`, or throw AuthError:
 *   unknown/expired token → 401; no token on a private topic, or a token without the grant → 403.
 */
export async function authorize(db: D1Database, req: Request, topic: string, perm: Permission, now: number, waitUntil?: (p: Promise<unknown>) => void): Promise<AuthResult> {
	return authorizeToken(db, bearerToken(req), topic, perm, now, waitUntil);
}

/** Same as authorize, for a token that came from somewhere other than the header (the publish URL). */
export async function authorizeToken(db: D1Database, token: string | null, topic: string, perm: Permission, now: number, waitUntil?: (p: Promise<unknown>) => void): Promise<AuthResult> {
	if (!token) {
		if ((await publicPermissions(db, topic))[perm]) return { tokenId: null };
		throw new AuthError(403, `This topic is private: send a token with ${perm} access.`);
	}
	const row = await findTokenByHash(db, await hashToken(token));
	if (!row || (row.expires_at && row.expires_at <= now)) throw new AuthError(401, "Unknown or expired token.");
	const grants = JSON.parse(row.grants) as Grant[];
	if (!grantsAllow(grants, topic, perm) && !(await publicPermissions(db, topic))[perm]) {
		throw new AuthError(403, `This token has no ${perm} access to "${topic}".`);
	}
	// last_used_at is informational; write it at most every 5 minutes.
	if (!row.last_used_at || now - row.last_used_at > 300) {
		const p = touchToken(db, row.id, now).catch(() => {});
		if (waitUntil) waitUntil(p);
	}
	return { tokenId: row.id };
}
