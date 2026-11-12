import type { Env } from "./env";

/**
 * Verifies the Cloudflare Access JWT (Cf-Access-Jwt-Assertion): defense in depth behind the
 * Access application that protects /admin and /api/admin. RS256 only, keys from the team's JWKS,
 * audience, issuer and expiry checked.
 */

interface Jwk extends JsonWebKey {
	kid: string;
}

let jwksCache: { at: number; keys: Map<string, CryptoKey> } | null = null;

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

async function getKeys(teamDomain: string, force = false): Promise<Map<string, CryptoKey>> {
	if (!force && jwksCache && Date.now() - jwksCache.at < 600_000) return jwksCache.keys;
	const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
	if (!res.ok) throw new Error(`Access certs HTTP ${res.status}`);
	const { keys } = (await res.json()) as { keys: Jwk[] };
	const map = new Map<string, CryptoKey>();
	for (const k of keys) {
		map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
	}
	jwksCache = { at: Date.now(), keys: map };
	return map;
}

export interface AccessIdentity {
	email: string;
}

export async function verifyAccessJwt(token: string, teamDomain: string, aud: string): Promise<AccessIdentity> {
	const [h, p, s] = token.split(".");
	if (!h || !p || !s) throw new Error("malformed token");
	const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h))) as { kid: string; alg: string };
	if (header.alg !== "RS256") throw new Error("unexpected alg");
	let keys = await getKeys(teamDomain);
	if (!keys.has(header.kid)) keys = await getKeys(teamDomain, true);
	const key = keys.get(header.kid);
	if (!key) throw new Error("unknown kid");
	const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlToBytes(s), new TextEncoder().encode(`${h}.${p}`));
	if (!ok) throw new Error("bad signature");
	const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(p))) as { aud: string | string[]; exp: number; iss: string; email?: string; common_name?: string };
	const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	if (!auds.includes(aud)) throw new Error("wrong audience");
	if (payload.exp * 1000 < Date.now()) throw new Error("expired");
	if (payload.iss !== `https://${teamDomain}`) throw new Error("wrong issuer");
	return { email: payload.email ?? payload.common_name ?? "service-token" };
}

export async function authenticate(req: Request, env: Env): Promise<AccessIdentity | null> {
	const url = new URL(req.url);
	// Dev escape hatch for `cf dev`. Production requests always carry the routed custom hostname.
	if (["localhost", "127.0.0.1"].includes(url.hostname)) return { email: "dev@localhost" };
	if (!env.ACCESS_AUD || !env.ACCESS_TEAM_DOMAIN) return null;
	const token = req.headers.get("cf-access-jwt-assertion");
	if (!token) return null;
	try {
		return await verifyAccessJwt(token, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
	} catch (e) {
		console.warn("access jwt rejected:", (e as Error).message);
		return null;
	}
}
