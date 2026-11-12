import type { NtfyAction } from "@shared/types";
import { randomString } from "./util";

/**
 * Port of ntfy's action parser (binwiederhier/ntfy action/action.go): accepts the JSON array
 * form and the "simple" form, e.g. `view, Open, https://x; http, Close, https://y, method=PUT`.
 */

const ACTIONS_MAX = 3;
const ALL = ["view", "broadcast", "http", "copy"];
const WITH_URL = ["view", "http"];
const WITH_VALUE = ["copy"];
const KEY_RE = /^([-.\w]+)\s*=\s*/;

type Draft = Partial<NtfyAction> & { headers: Record<string, string>; extras: Record<string, string> };

export function parseActions(input: string): NtfyAction[] {
	const s = input.trim();
	let drafts: Draft[];
	if (s.startsWith("[")) {
		let raw: unknown;
		try {
			raw = JSON.parse(s);
		} catch (e) {
			throw new Error(`JSON error: ${(e as Error).message}`);
		}
		if (!Array.isArray(raw)) throw new Error("JSON error: expected an array");
		drafts = raw.map((r) => {
			const o = (r ?? {}) as Record<string, unknown>;
			return {
				action: String(o.action ?? "") as NtfyAction["action"],
				label: String(o.label ?? ""),
				clear: o.clear === true,
				url: o.url != null ? String(o.url) : undefined,
				method: o.method != null ? String(o.method) : undefined,
				body: o.body != null ? String(o.body) : undefined,
				intent: o.intent != null ? String(o.intent) : undefined,
				value: o.value != null ? String(o.value) : undefined,
				headers: stringMap(o.headers),
				extras: stringMap(o.extras),
			};
		});
	} else {
		drafts = new SimpleParser(s).parse();
	}
	const actions = drafts.map((d) => finish(d));
	if (actions.length > ACTIONS_MAX) throw new Error(`only ${ACTIONS_MAX} actions allowed`);
	for (const a of actions) {
		if (!ALL.includes(a.action)) throw new Error(`parameter 'action' cannot be '${a.action}', valid values are 'view', 'broadcast', 'http' and 'copy'`);
		if (!a.label) throw new Error("parameter 'label' is required");
		if (WITH_URL.includes(a.action) && !a.url) throw new Error(`parameter 'url' is required for action '${a.action}'`);
		if (WITH_VALUE.includes(a.action) && !a.value) throw new Error(`parameter 'value' is required for action '${a.action}'`);
		if (a.action === "http" && ["GET", "HEAD"].includes(a.method ?? "") && a.body) throw new Error(`parameter 'body' cannot be set if method is ${a.method}`);
	}
	return actions;
}

function stringMap(v: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) out[k] = String(x);
	return out;
}

function finish(d: Draft): NtfyAction {
	const a: NtfyAction = { id: randomString(10), action: (d.action ?? "").toLowerCase() as NtfyAction["action"], label: d.label ?? "", clear: !!d.clear };
	if (d.url) a.url = d.url;
	if (d.method) a.method = d.method.toUpperCase();
	if (Object.keys(d.headers).length) a.headers = d.headers;
	if (d.body) a.body = d.body;
	if (d.intent) a.intent = d.intent;
	if (Object.keys(d.extras).length) a.extras = d.extras;
	if (d.value) a.value = d.value;
	return a;
}

const EOF = "";
const isSpace = (r: string) => r === " " || r === "\t" || r === "\r" || r === "\n";
const isSectionEnd = (r: string) => r === EOF || r === ";" || r === ",";
const isLastSection = (r: string) => r === EOF || r === ";";

class SimpleParser {
	private pos = 0;
	private readonly chars: string[];
	constructor(input: string) {
		this.chars = [...input];
	}
	private peek(): string {
		return this.pos >= this.chars.length ? EOF : this.chars[this.pos];
	}
	private eof() {
		return this.pos >= this.chars.length;
	}
	private rest() {
		return this.chars.slice(this.pos).join("");
	}
	parse(): Draft[] {
		const out: Draft[] = [];
		while (!this.eof()) out.push(this.parseAction());
		return out;
	}
	private parseAction(): Draft {
		const a: Draft = { headers: {}, extras: {} };
		let section = 0;
		for (;;) {
			const { key, value, last } = this.parseSection();
			populate(a, section, key, value);
			this.slurpSpaces();
			if (last) return a;
			section++;
		}
	}
	private parseSection(): { key: string; value: string; last: boolean } {
		this.slurpSpaces();
		const key = this.parseKey();
		const r = this.peek();
		if (isSectionEnd(r)) {
			if (r !== EOF) this.pos++;
			return { key, value: "", last: isLastSection(r) };
		}
		if (r === '"' || r === "'") return { key, ...this.parseQuoted(r) };
		return { key, ...this.parseValue() };
	}
	private parseKey(): string {
		const m = KEY_RE.exec(this.rest());
		if (!m) return "";
		this.pos += [...m[0]].length;
		return m[1];
	}
	private parseValue(): { value: string; last: boolean } {
		const start = this.pos;
		for (;;) {
			const r = this.peek();
			if (isSectionEnd(r)) {
				const value = this.chars.slice(start, this.pos).join("").trim();
				if (r !== EOF) this.pos++;
				return { value, last: isLastSection(r) };
			}
			this.pos++;
		}
	}
	private parseQuoted(quote: string): { value: string; last: boolean } {
		this.pos++;
		const start = this.pos;
		let prev = "";
		for (;;) {
			const r = this.peek();
			if (r === EOF) throw new Error(`unexpected end of input, quote started at position ${start}`);
			if (r === quote && prev !== "\\") {
				const value = this.chars.slice(start, this.pos).join("").replaceAll("\\" + quote, quote);
				this.pos++;
				this.slurpSpaces();
				const n = this.peek();
				if (!isSectionEnd(n)) throw new Error(`unexpected character '${n}' at position ${this.pos}`);
				if (n !== EOF) this.pos++;
				return { value, last: isLastSection(n) };
			}
			prev = r;
			this.pos++;
		}
	}
	private slurpSpaces() {
		while (!this.eof() && isSpace(this.peek())) this.pos++;
	}
}

function populate(a: Draft, section: number, rawKey: string, value: string) {
	let key = rawKey;
	if (!key && section === 0) key = "action";
	else if (!key && section === 1) key = "label";
	else if (!key && section === 2 && WITH_URL.includes((a.action ?? "").toLowerCase())) key = "url";
	else if (!key && section === 2 && WITH_VALUE.includes((a.action ?? "").toLowerCase())) key = "value";
	if (!key) throw new Error(`term '${value}' unknown`);
	if (key.startsWith("headers.")) {
		a.headers[key.slice(8)] = value;
		return;
	}
	if (key.startsWith("extras.")) {
		a.extras[key.slice(7)] = value;
		return;
	}
	switch (key.toLowerCase()) {
		case "action":
			a.action = value as NtfyAction["action"];
			break;
		case "label":
			a.label = value;
			break;
		case "clear": {
			const l = value.toLowerCase();
			if (!["true", "yes", "1", "false", "no", "0"].includes(l)) throw new Error(`parameter 'clear' cannot be '${value}', only boolean values are allowed (true/yes/1/false/no/0)`);
			a.clear = l === "true" || l === "yes" || l === "1";
			break;
		}
		case "url":
			a.url = value;
			break;
		case "method":
			a.method = value;
			break;
		case "body":
			a.body = value;
			break;
		case "value":
			a.value = value;
			break;
		case "intent":
			a.intent = value;
			break;
		default:
			throw new Error(`key '${key}' unknown`);
	}
}
