import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newMessage } from "../src/worker/ntfy/message";
import { buildPollRequest, forwardPollRequest, upstreamTopicHash } from "../src/worker/ntfy/upstream";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("iOS poll_request upstream", () => {
	it("hashes <base-url>/<topic> with SHA-256, like ntfy and the iOS app", async () => {
		expect(await upstreamTopicHash("https://ntfy.example.com", "mytopic")).toBe(sha("https://ntfy.example.com/mytopic"));
		// The iOS app strips trailing slashes before hashing (normalizeBaseUrl); so do we.
		expect(await upstreamTopicHash("https://ntfy.example.com//", "mytopic")).toBe(sha("https://ntfy.example.com/mytopic"));
		// Fixed vector (python3 hashlib.sha256(b"https://ntfy.example.com/mytopic").hexdigest())
		expect(await upstreamTopicHash("https://ntfy.example.com", "mytopic")).toBe("6de73be8dfb7d69e32fb2c00c23fe7adbd8b5504406e3068c273aa24cef4055b");
	});

	it("POSTs an empty body to <upstream>/<hash> with X-Poll-ID", async () => {
		const m = newMessage("message", "mytopic", "secret content");
		const r = await buildPollRequest({ baseUrl: "https://ntfy.example.com", upstreamBaseUrl: "https://ntfy.sh/", userAgent: "lemmeknow/test" }, m);
		expect(r.url).toBe(`https://ntfy.sh/${sha("https://ntfy.example.com/mytopic")}`);
		expect(r.init.method).toBe("POST");
		expect(r.init.body).toBe("");
		expect(r.init.headers).toEqual({ "User-Agent": "lemmeknow/test", "X-Poll-ID": m.id });
		expect(JSON.stringify(r)).not.toContain("secret content");
	});

	it("adds the upstream access token as Bearer auth when configured", async () => {
		const m = newMessage("message", "t");
		const r = await buildPollRequest({ baseUrl: "https://ntfy.example.com", upstreamBaseUrl: "https://ntfy.sh", accessToken: "tk_upstream", userAgent: "x" }, m);
		expect(r.init.headers.Authorization).toBe("Bearer tk_upstream");
	});

	it("reports failures without throwing", async () => {
		const m = newMessage("message", "t");
		const opts = { baseUrl: "https://ntfy.example.com", upstreamBaseUrl: "https://ntfy.sh", userAgent: "x" };
		expect(await forwardPollRequest(opts, m, (async () => new Response("", { status: 429 })) as typeof fetch)).toBe(false);
		expect(await forwardPollRequest(opts, m, (async () => { throw new Error("offline"); }) as typeof fetch)).toBe(false);
		expect(await forwardPollRequest(opts, m, (async () => new Response("{}", { status: 200 })) as typeof fetch)).toBe(true);
	});
});
