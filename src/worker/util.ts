/** Small helpers shared by the Worker modules. Everything random comes from Web Crypto. */

export const nowSec = () => Math.floor(Date.now() / 1000);

const enc = new TextEncoder();
export const utf8 = (s: string) => enc.encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function b64url(bytes: Uint8Array | ArrayBuffer): string {
	const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let s = "";
	for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
	return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
	const clean = s.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(clean + "===".slice((clean.length + 3) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0)) as Uint8Array<ArrayBuffer>;
}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Uniform random string from `alphabet` (rejection sampling, no modulo bias). */
export function randomString(n: number, alphabet = ALNUM): string {
	const max = 256 - (256 % alphabet.length);
	let out = "";
	while (out.length < n) {
		for (const b of crypto.getRandomValues(new Uint8Array(n * 2))) {
			if (b < max) out += alphabet[b % alphabet.length];
			if (out.length === n) break;
		}
	}
	return out;
}

export async function sha256Hex(s: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(s)));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const RESERVED = new Set(["admin", "api", "assets", "healthz", "sw", "manifest", "icons", "static"]);

/** Topic names: 1-64 letters, digits, `-` or `_`, and not a reserved word. */
export function isValidTopic(t: string): boolean {
	return /^[-_A-Za-z0-9]{1,64}$/.test(t) && !RESERVED.has(t.toLowerCase());
}

export const normalizeBaseUrl = (u: string) => u.replace(/\/+$/, "");
