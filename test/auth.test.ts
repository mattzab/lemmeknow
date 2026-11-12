import { describe, expect, it } from "vitest";
import { authorize, generateToken, grantsAllow, hashToken, matchTopicPattern, parseCredential, readAuthValue } from "../src/worker/auth";
import { NtfyError } from "../src/worker/ntfy/errors";
import { b64urlEncode } from "../src/worker/ntfy/util";
import { insertToken, upsertTopic } from "../src/worker/store";
import { fakeEnv, req } from "./helpers";

const basic = (u: string, p: string) => "Basic " + btoa(`${u}:${p}`);

async function mint(db: D1Database, grants: { topic: string; read: boolean; write: boolean }[], expires_at: number | null = null) {
	const token = generateToken();
	await insertToken(db, { id: token.slice(-8), label: "t", token_hash: await hashToken(token), prefix: token.slice(0, 7), grants: JSON.stringify(grants), created_at: 1, last_used_at: null, expires_at });
	return token;
}

async function code(p: Promise<unknown>): Promise<number | "ok"> {
	try {
		await p;
		return "ok";
	} catch (e) {
		if (e instanceof NtfyError) return e.http;
		throw e;
	}
}

describe("tokens", () => {
	it("look like ntfy tokens", () => {
		expect(generateToken()).toMatch(/^tk_[a-z0-9]{29}$/);
		expect(generateToken()).not.toBe(generateToken());
	});
});

describe("credentials", () => {
	it("reads Bearer and Basic (password = token, any username)", () => {
		expect(parseCredential("Bearer tk_abc")).toEqual({ kind: "token", token: "tk_abc" });
		expect(parseCredential(basic("phone", "tk_abc"))).toEqual({ kind: "token", token: "tk_abc" });
		expect(parseCredential(basic("", "tk_abc"))).toEqual({ kind: "token", token: "tk_abc" });
		expect(parseCredential(basic("user", ""))).toEqual({ kind: "invalid" });
		expect(parseCredential("Basic !!!")).toEqual({ kind: "invalid" });
		expect(parseCredential("")).toEqual({ kind: "none" });
		expect(parseCredential("vapid t=x")).toEqual({ kind: "none" });
	});

	it("reads ?auth= as base64url of the header value, overriding the header", () => {
		const r = req(`/t/json?auth=${b64urlEncode("Bearer tk_fromquery")}`, { headers: { authorization: "Bearer tk_header" } });
		expect(parseCredential(readAuthValue(r))).toEqual({ kind: "token", token: "tk_fromquery" });
		const r2 = req(`/t/json?auth=${b64urlEncode(basic("x", "tk_q"))}`);
		expect(parseCredential(readAuthValue(r2))).toEqual({ kind: "token", token: "tk_q" });
		expect(parseCredential(readAuthValue(req("/t/json?auth=%%%")))).toEqual({ kind: "invalid" });
	});

	it("matches topic patterns with * wildcards, case-sensitively", () => {
		expect(matchTopicPattern("*", "anything")).toBe(true);
		expect(matchTopicPattern("alerts_*", "alerts_disk")).toBe(true);
		expect(matchTopicPattern("alerts_*", "alerts")).toBe(false);
		expect(matchTopicPattern("a.b", "aXb")).toBe(false);
		expect(matchTopicPattern("Home", "home")).toBe(false);
		expect(grantsAllow([{ topic: "x", read: true, write: false }], "x", "write")).toBe(false);
	});
});

describe("authorize", () => {
	it("enforces grants: 401 for bad tokens, 403 for missing grants or anonymous", async () => {
		const { env } = await fakeEnv();
		const ro = await mint(env.DB, [{ topic: "news", read: true, write: false }]);
		const rw = await mint(env.DB, [{ topic: "home_*", read: true, write: true }]);
		const expired = await mint(env.DB, [{ topic: "*", read: true, write: true }], 10);
		const auth = (token: string | null, topics: string[], perm: "read" | "write") =>
			code(authorize(env.DB, req("/x", token ? { headers: { authorization: `Bearer ${token}` } } : {}), topics, perm, 1000));

		expect(await auth(ro, ["news"], "read")).toBe("ok");
		expect(await auth(ro, ["news"], "write")).toBe(403);
		expect(await auth(rw, ["home_door", "home_temp"], "write")).toBe("ok");
		expect(await auth(rw, ["home_door", "news"], "read")).toBe(403);
		expect(await auth("tk_nope", ["news"], "read")).toBe(401);
		expect(await auth(expired, ["news"], "read")).toBe(401);
		expect(await auth(null, ["news"], "read")).toBe(403);
	});

	it("allows anonymous access only where a topic enables it", async () => {
		const { env } = await fakeEnv();
		await upsertTopic(env.DB, { name: "public", anon_read: true }, 1);
		const anon = (topics: string[], perm: "read" | "write") => code(authorize(env.DB, req("/x"), topics, perm, 1000));
		expect(await anon(["public"], "read")).toBe("ok");
		expect(await anon(["public"], "write")).toBe(403);
		expect(await anon(["public", "private"], "read")).toBe(403);
	});

	it("records last use at most every 5 minutes", async () => {
		const { env, sql } = await fakeEnv();
		const t = await mint(env.DB, [{ topic: "*", read: true, write: true }]);
		const waits: Promise<unknown>[] = [];
		await authorize(env.DB, req("/x", { headers: { authorization: `Bearer ${t}` } }), ["a"], "read", 5000, (p) => waits.push(p));
		await Promise.all(waits);
		expect((sql.prepare("SELECT last_used_at FROM tokens").get() as { last_used_at: number }).last_used_at).toBe(5000);
		await authorize(env.DB, req("/x", { headers: { authorization: `Bearer ${t}` } }), ["a"], "read", 5100, (p) => waits.push(p));
		expect(waits).toHaveLength(1);
	});
});
