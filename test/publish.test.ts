import { describe, expect, it } from "vitest";
import { parseActions } from "../src/worker/ntfy/actions";
import { NtfyError } from "../src/worker/ntfy/errors";
import { jsonPublishToRequest, parsePublish } from "../src/worker/ntfy/publish";
import { Params } from "../src/worker/ntfy/util";

const NOW = 1_800_000_000;
const opts = { cacheDurationSeconds: 43200, now: NOW };
const enc = (s: string) => new TextEncoder().encode(s);
const P = (headers: Record<string, string> = {}, query = "") => new Params(new Headers(headers), new URLSearchParams(query));
const pub = (headers: Record<string, string> = {}, body = "", query = "", topic = "mytopic") => parsePublish(P(headers, query), topic, enc(body), opts);

function ntfyError(fn: () => unknown): NtfyError {
	try {
		fn();
	} catch (e) {
		if (e instanceof NtfyError) return e;
		throw e;
	}
	throw new Error("expected an NtfyError");
}

describe("parsePublish", () => {
	it("builds a plain message with ntfy defaults", () => {
		const r = pub({}, "  Backup done \n");
		expect(r.message).toMatchObject({ event: "message", topic: "mytopic", message: "Backup done", time: NOW, expires: NOW + 43200 });
		expect(r.message.id).toMatch(/^[A-Za-z0-9]{12}$/);
		expect(r).toMatchObject({ cache: true, upstream: true, delayed: false });
	});

	it('uses "triggered" for an empty body', () => {
		expect(pub().message.message).toBe("triggered");
	});

	it("reads headers and all query aliases", () => {
		const h = pub({ "X-Title": "Hi", Priority: "high", Tags: "warning, skull", Click: "https://example.com", Markdown: "yes" }).message;
		expect(h).toMatchObject({ title: "Hi", priority: 4, tags: ["warning", "skull"], click: "https://example.com", content_type: "text/markdown" });
		const q = pub({}, "", "t=Hi&p=5&ta=a,b&md=1&icon=https://example.com/i.png").message;
		expect(q).toMatchObject({ title: "Hi", priority: 5, tags: ["a", "b"], content_type: "text/markdown", icon: "https://example.com/i.png" });
		expect(pub({}, "", "message=via%20query").message.message).toBe("via query");
		expect(pub({}, "", "m=line1\\nline2").message.message).toBe("line1\nline2");
	});

	it("headers win over query parameters", () => {
		expect(pub({ Title: "header" }, "", "title=query").message.title).toBe("header");
	});

	it("parses every priority spelling and rejects junk", () => {
		const names: Record<string, number> = { "1": 1, min: 1, "2": 2, low: 2, "3": 3, default: 3, "4": 4, high: 4, "5": 5, max: 5, urgent: 5, URGENT: 5 };
		for (const [k, v] of Object.entries(names)) expect(pub({ "X-Priority": k }).message.priority).toBe(v);
		expect(ntfyError(() => pub({ "X-Priority": "6" })).code).toBe(40007);
	});

	it("ignores the RFC 9218 Priority header Cloudflare injects", () => {
		expect(pub({ Priority: "u=3, i" }).message.priority).toBeUndefined();
		expect(pub({ Priority: "u=1" }, "", "priority=4").message.priority).toBe(4);
	});

	it("decodes RFC 2047 encoded-word headers", () => {
		expect(pub({ Title: "=?UTF-8?B?w4ljaG8=?=" }).message.title).toBe("Écho");
		expect(pub({ Title: "=?UTF-8?Q?caf=C3=A9_bar?=" }).message.title).toBe("café bar");
	});

	it("handles external attachments and validates URLs", () => {
		const m = pub({ Attach: "https://example.com/files/report.pdf" }).message;
		expect(m.attachment).toEqual({ name: "report.pdf", url: "https://example.com/files/report.pdf" });
		expect(m.message).toBe("You received a file: report.pdf");
		expect(pub({ Attach: "https://example.com/x.jpg", Filename: "cat.jpg" }, "look").message).toMatchObject({ message: "look", attachment: { name: "cat.jpg" } });
		expect(ntfyError(() => pub({ Attach: "ftp://x" })).code).toBe(40013);
		expect(ntfyError(() => pub({ Icon: "javascript:alert(1)" })).code).toBe(40021);
	});

	it("rejects file uploads (not supported yet) and oversized or binary bodies", () => {
		expect(ntfyError(() => pub({ Filename: "a.txt" }, "data")).code).toBe(40014);
		expect(ntfyError(() => pub({}, "x".repeat(5000))).code).toBe(40014);
		expect(ntfyError(() => parsePublish(P(), "t", new Uint8Array([0xff, 0xfe]), opts)).code).toBe(40014);
	});

	it("schedules delayed messages within ntfy's limits", () => {
		const r = pub({ Delay: "30m" });
		expect(r.delayed).toBe(true);
		expect(r.message.time).toBe(NOW + 1800);
		expect(r.message.expires).toBe(NOW + 1800 + 43200);
		expect(pub({}, "", `at=${NOW + 3600}`).message.time).toBe(NOW + 3600);
		expect(pub({ In: "1 day" }).message.time).toBe(NOW + 86400);
		expect(ntfyError(() => pub({ Delay: "5s" })).code).toBe(40005);
		expect(ntfyError(() => pub({ Delay: "4d" })).code).toBe(40006);
		expect(ntfyError(() => pub({ Delay: "soonish" })).code).toBe(40004);
		expect(ntfyError(() => pub({ Delay: "1h", Cache: "no" })).code).toBe(40002);
	});

	it("does not cache with Cache: no", () => {
		const r = pub({ Cache: "no" });
		expect(r.cache).toBe(false);
		expect(r.message.expires).toBeUndefined();
	});

	it("rejects e-mail and phone calls (not offered)", () => {
		expect(ntfyError(() => pub({ Email: "a@example.com" })).code).toBe(40031);
		expect(ntfyError(() => pub({ Call: "+15555550100" })).code).toBe(40034);
	});

	it("turns X-Poll-ID into a poll_request (what an upstream server does)", () => {
		const r = pub({ "X-Poll-ID": "abcDEF123456" }, "ignored");
		expect(r.message).toMatchObject({ event: "poll_request", message: "New message", poll_id: "abcDEF123456" });
		expect(r).toMatchObject({ cache: false, upstream: false });
	});

	it("base64-encodes binary UnifiedPush bodies and skips the upstream", () => {
		const r = parsePublish(P({}, "up=1"), "upABC", new Uint8Array([0xff, 0x00]), opts);
		expect(r.message).toMatchObject({ message: "/wA=", encoding: "base64" });
		expect(r.upstream).toBe(false);
	});

	it("validates topic names", () => {
		expect(ntfyError(() => pub({}, "", "", "bad topic")).code).toBe(40009);
		expect(ntfyError(() => pub({}, "", "", "x".repeat(65))).code).toBe(40009);
		expect(ntfyError(() => pub({}, "", "", "admin")).code).toBe(40009);
	});
});

describe("parseActions", () => {
	it("parses the simple format with positional and key=value fields", () => {
		const a = parseActions('view, Open portal, https://home.example.com, clear=true; http, "Close door, now", https://api.example.com/door, method=put, headers.Authorization=Bearer x, body={"a":1}');
		expect(a).toHaveLength(2);
		expect(a[0]).toMatchObject({ action: "view", label: "Open portal", url: "https://home.example.com", clear: true });
		expect(a[1]).toMatchObject({ action: "http", label: "Close door, now", method: "PUT", headers: { Authorization: "Bearer x" }, body: '{"a":1}' });
		expect(a[0].id).toMatch(/^[A-Za-z0-9]{10}$/);
	});

	it("parses broadcast extras and copy values", () => {
		expect(parseActions("broadcast, Take photo, extras.cmd=pic, extras.camera=front")[0]).toMatchObject({ action: "broadcast", extras: { cmd: "pic", camera: "front" } });
		expect(parseActions("copy, Copy code, 123456")[0]).toMatchObject({ action: "copy", value: "123456" });
	});

	it("parses the JSON format", () => {
		const a = parseActions('[{"action":"view","label":"Docs","url":"https://docs.ntfy.sh","clear":true}]');
		expect(a[0]).toMatchObject({ action: "view", label: "Docs", url: "https://docs.ntfy.sh", clear: true });
	});

	it("validates like ntfy", () => {
		expect(() => parseActions("view, Missing url")).toThrow(/url/);
		expect(() => parseActions("dance, Go")).toThrow(/cannot be 'dance'/);
		expect(() => parseActions("view, a, https://x; view, b, https://x; view, c, https://x; view, d, https://x")).toThrow(/only 3/);
		expect(() => parseActions("http, Get, https://x, method=GET, body=nope")).toThrow(/body/);
		expect(() => parseActions('view, "unterminated')).toThrow(/unexpected end/);
	});

	it("maps action errors to ntfy error 40018", () => {
		expect(ntfyError(() => pub({ Actions: "view, broken" })).code).toBe(40018);
	});
});

describe("JSON publishing", () => {
	it("rewrites a JSON body into a normal publish", () => {
		const j = jsonPublishToRequest(
			JSON.stringify({ topic: "mytopic", message: "Disk full", title: "Alert", priority: 5, tags: ["warning"], click: "https://x.example", markdown: true, actions: [{ action: "view", label: "Open", url: "https://x.example" }] }),
		);
		const r = parsePublish(j.params, j.topic, j.body, opts);
		expect(r.message).toMatchObject({ topic: "mytopic", message: "Disk full", title: "Alert", priority: 5, tags: ["warning"], click: "https://x.example", content_type: "text/markdown" });
		expect(r.message.actions?.[0]).toMatchObject({ action: "view", label: "Open" });
	});

	it("requires a valid topic and JSON object", () => {
		expect(ntfyError(() => jsonPublishToRequest("{nope")).code).toBe(40017);
		expect(ntfyError(() => jsonPublishToRequest('{"message":"x"}')).code).toBe(40009);
	});
});
