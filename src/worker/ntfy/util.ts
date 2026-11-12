/** Small helpers that mirror ntfy's request parsing (server/util.go). */

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Cryptographically random string from `alphabet` (rejection sampling, no modulo bias). */
export function randomString(length: number, alphabet = ALNUM): string {
	const out: string[] = [];
	const limit = 256 - (256 % alphabet.length);
	while (out.length < length) {
		const buf = crypto.getRandomValues(new Uint8Array(length * 2));
		for (const b of buf) {
			if (b < limit) out.push(alphabet[b % alphabet.length]);
			if (out.length === length) break;
		}
	}
	return out.join("");
}

export const MESSAGE_ID_LENGTH = 12;
export const newMessageId = () => randomString(MESSAGE_ID_LENGTH);
export const isMessageId = (s: string) => new RegExp(`^[A-Za-z0-9]{${MESSAGE_ID_LENGTH}}$`).test(s);

export const TOPIC_RE = /^[-_A-Za-z0-9]{1,64}$/;
/** Topic names the Worker uses for its own routes and therefore never accepts. */
export const RESERVED_TOPICS = new Set(["admin", "api", "assets", "docs", "file", "static", "v1", "favicon.svg"]);
export function isValidTopic(t: string): boolean {
	return TOPIC_RE.test(t) && !RESERVED_TOPICS.has(t.toLowerCase());
}

/** RFC 9218 "Priority" header Cloudflare adds to requests (e.g. "u=3, i"): not an ntfy priority. */
const PRIORITY_HEADER_IGNORE = /^u=\d,\s*(i|\d)$|^u=\d$/;

/** RFC 2047 encoded-word decoding (=?UTF-8?B?...?= / =?UTF-8?Q?...?=), as Go's mime.WordDecoder does. */
export function decodeHeader(value: string): string {
	if (!value.includes("=?")) return value;
	return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
		try {
			let bytes: Uint8Array;
			if (enc.toUpperCase() === "B") {
				bytes = Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
			} else {
				const s = text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16)));
				bytes = Uint8Array.from(s, (c) => c.charCodeAt(0));
			}
			return new TextDecoder(charset.toLowerCase()).decode(bytes);
		} catch {
			return _m;
		}
	});
}

/** Request view used by the parsers: headers first, then lower-cased query parameters (ntfy's readParam). */
export class Params {
	constructor(
		readonly headers: Headers,
		readonly query: URLSearchParams,
	) {}
	static from(req: Request): Params {
		return new Params(req.headers, new URL(req.url).searchParams);
	}
	header(...names: string[]): string {
		for (const name of names) {
			let v = (this.headers.get(name) ?? "").trim();
			if (!v) continue;
			v = decodeHeader(v).trim();
			if (name.toLowerCase() === "priority" && PRIORITY_HEADER_IGNORE.test(v)) continue;
			if (v) return v;
		}
		return "";
	}
	queryParam(...names: string[]): string {
		for (const name of names) {
			const v = (this.query.get(name.toLowerCase()) ?? "").trim();
			if (v) return v;
		}
		return "";
	}
	get(...names: string[]): string {
		return this.header(...names) || this.queryParam(...names);
	}
	bool(def: boolean, ...names: string[]): boolean {
		const v = this.get(...names).toLowerCase();
		if (!v) return def;
		return toBool(v);
	}
	list(...names: string[]): string[] {
		const v = this.get(...names);
		return v ? splitNoEmpty(v, ",").map((s) => s.trim()) : [];
	}
}

export const toBool = (v: string) => v === "1" || v === "yes" || v === "true";
export const isBoolValue = (v: string) => ["1", "yes", "true", "0", "no", "false"].includes(v);
export const splitNoEmpty = (s: string, sep: string) => s.split(sep).filter((x) => x.trim() !== "");

/** ntfy util.ParsePriority: 1-5 or min/low/default/high/max/urgent; "" = 0 (unset). */
export function parsePriority(p: string): number | null {
	switch (p.trim().toLowerCase()) {
		case "":
			return 0;
		case "1":
		case "min":
			return 1;
		case "2":
		case "low":
			return 2;
		case "3":
		case "default":
			return 3;
		case "4":
		case "high":
			return 4;
		case "5":
		case "max":
		case "urgent":
			return 5;
		default:
			return null;
	}
}

const UNITS: Record<string, number> = {
	ns: 1e-9,
	us: 1e-6,
	µs: 1e-6,
	ms: 1e-3,
	s: 1,
	sec: 1,
	secs: 1,
	second: 1,
	seconds: 1,
	m: 60,
	min: 60,
	mins: 60,
	minute: 60,
	minutes: 60,
	h: 3600,
	hr: 3600,
	hrs: 3600,
	hour: 3600,
	hours: 3600,
	d: 86400,
	day: 86400,
	days: 86400,
	w: 604800,
	week: 604800,
	weeks: 604800,
};

/** Parse "30s", "10m", "2h", "1h30m", "1 day", "3 days" into seconds. Returns null if unparseable. */
export function parseDurationSeconds(s: string): number | null {
	const str = s.toLowerCase().replace(/\s+/g, "");
	if (!/^(\d+(?:\.\d+)?[a-zµ]+)+$/.test(str)) return null;
	let total = 0;
	for (const m of str.matchAll(/(\d+(?:\.\d+)?)([a-zµ]+)/g)) {
		const unit = UNITS[m[2]];
		if (unit == null) return null;
		total += Number(m[1]) * unit;
	}
	return total;
}

/**
 * ntfy util.ParseFutureTime, minus natural language: a unix timestamp or a duration from now.
 * Returns unix seconds or null.
 */
export function parseFutureTime(s: string, nowSec: number): number | null {
	const v = s.trim();
	if (/^\d+$/.test(v)) {
		const n = Number(v);
		return n;
	}
	const d = parseDurationSeconds(v);
	return d == null ? null : Math.floor(nowSec + d);
}

export const nowSec = () => Math.floor(Date.now() / 1000);

/** base64url decode (no padding) to string, as ntfy decodes `?auth=`. */
export function b64urlDecode(s: string): string {
	const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
	const bin = atob(b64);
	return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function b64urlEncode(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(s: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Strip whitespace and trailing slashes, as the ntfy iOS app's normalizeBaseUrl does. */
export function normalizeBaseUrl(u: string): string {
	let s = u.trim();
	while (s.endsWith("/")) s = s.slice(0, -1);
	return s;
}
