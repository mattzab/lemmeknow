import worker from "../src/worker/index";
import type { Env } from "../src/worker/env";
import { ensureSchema, resetSchemaFlag } from "../src/worker/store";
import { b64url, b64urlDecode, concat } from "../src/worker/util";
import { fakeD1 } from "./fake-d1";

export const HOST = "https://lemmeknow.example.com";

/** A fake Env with an in-memory D1 (node:sqlite) and a stub asset fetcher. */
export async function fakeEnv(overrides: Partial<Env> = {}) {
	const { db, sql, stats } = fakeD1();
	const env = {
		DB: db as unknown as D1Database,
		ASSETS: { fetch: async (r: Request) => new Response(`asset ${new URL(r.url).pathname}`) } as unknown as Fetcher,
		BASE_URL: HOST,
		ACCESS_TEAM_DOMAIN: "",
		ACCESS_AUD: "",
		RETENTION_SECONDS: String(7 * 86400),
		VAPID_SUBJECT: "",
		...overrides,
	} satisfies Env;
	resetSchemaFlag();
	await ensureSchema(env.DB);
	const waits: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p), passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
	/** Call the Worker like the runtime would. `base` defaults to the public host. */
	const call = async (path: string, init: RequestInit = {}, base = HOST) => {
		const res = await worker.fetch(new Request(base + path, init), env, ctx);
		return res;
	};
	const settle = async () => {
		while (waits.length) await Promise.all(waits.splice(0));
	};
	return { env, sql, stats, ctx, waits, call, settle };
}

export const json = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
	method: "POST",
	headers: { "content-type": "application/json", ...headers },
	body: JSON.stringify(body),
});

/** A browser-side push subscription: an ECDH key pair and auth secret, like PushManager makes. */
export async function fakeBrowserSubscription(endpoint = "https://web.push.apple.com/QGzVt0exampleToken") {
	const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
	const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
	const auth = crypto.getRandomValues(new Uint8Array(16));
	return { endpoint, keys: { p256dh: b64url(pub), auth: b64url(auth) }, privateKey: kp.privateKey };
}

async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>) {
	const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
const hkdf = async (salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, n: number) =>
	(await hmac(await hmac(salt, ikm), concat(info, new Uint8Array([1])))).slice(0, n);

/** Independent RFC 8291 decryption (what the browser does), to check what the Worker sends. */
export async function decryptPush(body: Uint8Array, uaPrivate: CryptoKey, p256dh: string, auth: string): Promise<string> {
	const salt = body.slice(0, 16);
	const idlen = body[20];
	const asPublic = body.slice(21, 21 + idlen);
	const ciphertext = body.slice(21 + idlen);
	const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
	const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaPrivate, 256));
	const te = new TextEncoder();
	const ikm = await hkdf(b64urlDecode(auth), ecdh, concat(te.encode("WebPush: info\0"), b64urlDecode(p256dh), asPublic), 32);
	const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
	const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
	const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
	const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
	if (plain[plain.length - 1] !== 2) throw new Error("missing last-record delimiter");
	return new TextDecoder().decode(plain.slice(0, -1));
}
