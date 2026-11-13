/**
 * Web Push sender on Web Crypto only (no Node libraries, no third-party relay):
 *   - RFC 8291 message encryption ("aes128gcm" content coding, RFC 8188), and
 *   - RFC 8292 VAPID: an ES256 JWT proving this deployment owns the key the browser subscribed with.
 * The push endpoint belongs to the subscriber's browser vendor (web.push.apple.com for iOS
 * Home Screen apps, fcm.googleapis.com for Chrome on Android, Mozilla for Firefox).
 */
import { b64url, b64urlDecode, concat, utf8 } from "./util";

export interface VapidKeys {
	/** Uncompressed P-256 public key (65 bytes), base64url: the browser's applicationServerKey. */
	publicKey: string;
	/** Private key as a JWK (P-256 ECDSA). */
	privateJwk: JsonWebKey;
}

export interface Subscription {
	endpoint: string;
	/** Browser's P-256 ECDH public key, base64url (65 bytes uncompressed). */
	p256dh: string;
	/** Browser's 16-byte auth secret, base64url. */
	auth: string;
}

/** New VAPID key pair for a deployment (generated once and stored in D1). */
export async function generateVapidKeys(): Promise<VapidKeys> {
	const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
	const raw = (await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer;
	const privateJwk = (await crypto.subtle.exportKey("jwk", kp.privateKey)) as JsonWebKey;
	return { publicKey: b64url(raw), privateJwk: { kty: privateJwk.kty, crv: privateJwk.crv, x: privateJwk.x, y: privateJwk.y, d: privateJwk.d } };
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF with a single expand block (all outputs here are <= 32 bytes). */
async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, length: number) {
	const prk = await hmac(salt, ikm);
	return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

export interface EncryptOptions {
	/** Test hooks: fixed sender key pair and salt (RFC 8291 §5 example). Random otherwise. */
	senderKeys?: CryptoKeyPair;
	salt?: Uint8Array<ArrayBuffer>;
}

/** Encrypt `plaintext` for one subscription: returns the full aes128gcm request body. */
export async function encryptPayload(sub: Pick<Subscription, "p256dh" | "auth">, plaintext: Uint8Array, opts: EncryptOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
	const uaPublic = b64urlDecode(sub.p256dh);
	const authSecret = b64urlDecode(sub.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh must be an uncompressed P-256 point");
	if (authSecret.length !== 16) throw new Error("auth must be 16 bytes");
	// importKey rejects points that are not on the curve (RFC 8291 §7 validation).
	const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const as = opts.senderKeys ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
	const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", as.publicKey)) as ArrayBuffer);
	const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
	const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));

	const keyInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
	const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
	const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

	// Single record: plaintext, then the 0x02 "last record" padding delimiter.
	const record = concat(plaintext, new Uint8Array([2]));
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
	const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, record));

	// Header: salt (16) | record size (uint32 BE) | key id length (1) | key id = sender public key (65).
	const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
	header.set(salt, 0);
	new DataView(header.buffer).setUint32(16, 4096);
	header[20] = asPublic.length;
	header.set(asPublic, 21);
	return concat(header, ciphertext);
}

const jwtCache = new Map<string, { jwt: string; until: number }>();

/** VAPID JWT for a push service origin. Valid 12 h (Apple rejects > 24 h); cached ~1 h per isolate. */
export async function vapidJwt(keys: VapidKeys, audience: string, subject: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
	const cacheKey = `${keys.publicKey}|${audience}|${subject}`;
	const hit = jwtCache.get(cacheKey);
	if (hit && hit.until > now) return hit.jwt;
	const header = b64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
	const claims = b64url(utf8(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject })));
	const key = await crypto.subtle.importKey("jwk", { ...keys.privateJwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
	// Web Crypto ECDSA signatures are already the raw r||s form JWS ES256 wants.
	const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`));
	const jwt = `${header}.${claims}.${b64url(sig)}`;
	if (jwtCache.size > 100) jwtCache.clear();
	jwtCache.set(cacheKey, { jwt, until: now + 3600 });
	return jwt;
}

export type Urgency = "very-low" | "low" | "normal" | "high";

export interface PushRequestOptions {
	ttl: number;
	urgency?: Urgency;
	subject: string;
	/** Test hook. */
	encrypt?: EncryptOptions;
}

/** Build (but do not send) the HTTP request that delivers `payload` to one subscription. */
export async function buildPushRequest(keys: VapidKeys, sub: Subscription, payload: Uint8Array, opts: PushRequestOptions): Promise<Request> {
	const audience = new URL(sub.endpoint).origin;
	const body = await encryptPayload(sub, payload, opts.encrypt);
	const jwt = await vapidJwt(keys, audience, opts.subject);
	return new Request(sub.endpoint, {
		method: "POST",
		headers: {
			authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
			"content-encoding": "aes128gcm",
			"content-type": "application/octet-stream",
			ttl: String(Math.max(1, Math.floor(opts.ttl))),
			urgency: opts.urgency ?? "normal",
		},
		body,
	});
}

export type PushOutcome = "sent" | "gone" | "failed";

export interface PushResult {
	endpoint: string;
	outcome: PushOutcome;
	status: number;
	reason?: string;
}

/** Send one push. 404/410 mean the subscription is gone and should be deleted. */
export async function sendPush(keys: VapidKeys, sub: Subscription, payload: Uint8Array, opts: PushRequestOptions): Promise<PushResult> {
	try {
		const res = await fetch(await buildPushRequest(keys, sub, payload, opts));
		const reason = res.ok ? undefined : (await res.text().catch(() => "")).slice(0, 200);
		const outcome: PushOutcome = res.ok ? "sent" : isGone(res.status, reason ?? "") ? "gone" : "failed";
		return { endpoint: sub.endpoint, outcome, status: res.status, reason };
	} catch (e) {
		return { endpoint: sub.endpoint, outcome: "failed", status: 0, reason: (e as Error).message };
	}
}

/**
 * The subscription will never work again: 404/410 from any push service, Apple's 400
 * BadDeviceToken, or a subscription made with a different VAPID key (403 VapidPkHashMismatch).
 */
export function isGone(status: number, reason: string): boolean {
	if (status === 404 || status === 410) return true;
	return (status === 400 && reason.includes("BadDeviceToken")) || (status === 403 && reason.includes("VapidPkHashMismatch"));
}

/** Only https push services on public hostnames are accepted as subscription endpoints. */
export function isAcceptableEndpoint(endpoint: string): boolean {
	let u: URL;
	try {
		u = new URL(endpoint);
	} catch {
		return false;
	}
	if (u.protocol !== "https:" || u.username || u.password || endpoint.length > 1024) return false;
	const h = u.hostname.toLowerCase();
	if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
	if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return false; // IP literals
	return h.includes(".");
}
