import { describe, expect, it } from "vitest";
import type { NtfyMessage } from "../src/shared/types";
import { newMessage } from "../src/worker/ntfy/message";
import { parseSince, parseSubscribeParams, passesFilters, topicsFromPath } from "../src/worker/ntfy/subscribe";
import { Params } from "../src/worker/ntfy/util";
import { claimDueMessages, fetchCached, insertMessage, pruneExpired } from "../src/worker/store";
import { fakeEnv } from "./helpers";

const NOW = 1_800_000_000;

function msg(topic: string, time: number, extra: Partial<NtfyMessage> = {}): NtfyMessage {
	return { ...newMessage("message", topic, "hello", time), expires: time + 3600, ...extra };
}

async function seeded() {
	const f = await fakeEnv();
	const a1 = msg("a", NOW - 300);
	const a2 = msg("a", NOW - 200, { tags: ["x"], priority: 5 });
	const b1 = msg("b", NOW - 100);
	const a3 = msg("a", NOW - 100);
	const old = msg("a", NOW - 9000, { expires: NOW - 1 });
	const later = msg("a", NOW + 600);
	for (const m of [a1, a2, b1, a3, old]) await insertMessage(f.env.DB, m, true, NOW);
	await insertMessage(f.env.DB, later, false, NOW);
	return { ...f, a1, a2, a3, b1, old, later };
}

const ids = (ms: NtfyMessage[]) => ms.map((m) => m.id);

describe("since parsing", () => {
	it("follows ntfy's rules", () => {
		expect(parseSince("", false)).toEqual({ kind: "none" });
		expect(parseSince("", true)).toEqual({ kind: "all" });
		expect(parseSince("all", false)).toEqual({ kind: "all" });
		expect(parseSince("latest", false)).toEqual({ kind: "latest" });
		expect(parseSince("none", true)).toEqual({ kind: "none" });
		expect(parseSince("1700000000", false)).toEqual({ kind: "time", time: 1700000000 });
		expect(parseSince("10m", false, NOW)).toEqual({ kind: "time", time: NOW - 600 });
		expect(parseSince("abcDEF123456", false)).toEqual({ kind: "id", id: "abcDEF123456" });
		expect(() => parseSince("yesterday-ish", false)).toThrow();
	});

	it("parses subscribe params and filters", () => {
		const sp = parseSubscribeParams(new Params(new Headers(), new URLSearchParams("poll=1&id=abcDEF123456&tags=a,b&priority=high,5&scheduled=1")));
		expect(sp).toMatchObject({ poll: true, scheduled: true, since: { kind: "all" }, filters: { id: "abcDEF123456", tags: ["a", "b"], priority: [4, 5] } });
		expect(parseSubscribeParams(new Params(new Headers({ "X-Poll": "1", "X-Since": "latest" }), new URLSearchParams())).since).toEqual({ kind: "latest" });
	});

	it("filters messages but never open/keepalive events", () => {
		const m = msg("a", 1, { tags: ["x", "y"], priority: 4 });
		expect(passesFilters({ tags: ["x"] }, m)).toBe(true);
		expect(passesFilters({ tags: ["z"] }, m)).toBe(false);
		expect(passesFilters({ priority: [3] }, msg("a", 1))).toBe(true); // unset = default 3
		expect(passesFilters({ priority: [5] }, m)).toBe(false);
		expect(passesFilters({ id: "nope" }, newMessage("keepalive", "a"))).toBe(true);
	});

	it("parses multi-topic paths", () => {
		expect(topicsFromPath("a,b,a")).toEqual(["a", "b"]);
		expect(() => topicsFromPath("a,,b")).toThrow();
		expect(() => topicsFromPath("a b")).toThrow();
	});
});

describe("cache replay (poll / since / id)", () => {
	it("returns all unexpired, published messages oldest first", async () => {
		const s = await seeded();
		const all = await fetchCached(s.env.DB, ["a"], { kind: "all" }, { now: NOW });
		expect(ids(all)).toEqual(ids([s.a1, s.a2, s.a3]));
	});

	it("merges topics in time order", async () => {
		const s = await seeded();
		expect(ids(await fetchCached(s.env.DB, ["a", "b"], { kind: "all" }, { now: NOW }))).toEqual(ids([s.a1, s.a2, s.b1, s.a3]));
	});

	it("supports since=<time>, since=<id> and since=latest", async () => {
		const s = await seeded();
		expect(ids(await fetchCached(s.env.DB, ["a"], { kind: "time", time: NOW - 200 }, { now: NOW }))).toEqual(ids([s.a2, s.a3]));
		expect(ids(await fetchCached(s.env.DB, ["a", "b"], { kind: "id", id: s.a2.id }, { now: NOW }))).toEqual(ids([s.b1, s.a3]));
		// Same-second messages are ordered by insertion, so since=<id> never skips or repeats.
		expect(ids(await fetchCached(s.env.DB, ["a", "b"], { kind: "id", id: s.b1.id }, { now: NOW }))).toEqual(ids([s.a3]));
		expect(ids(await fetchCached(s.env.DB, ["a", "b"], { kind: "latest" }, { now: NOW }))).toEqual(ids([s.b1, s.a3]));
		expect(await fetchCached(s.env.DB, ["a"], { kind: "none" }, { now: NOW })).toEqual([]);
	});

	it("an unknown since id falls back to everything", async () => {
		const s = await seeded();
		expect(await fetchCached(s.env.DB, ["a"], { kind: "id", id: "zzzzzzzzzzzz" }, { now: NOW })).toHaveLength(3);
	});

	it("fetches a single message by id (the iOS poll after a wakeup)", async () => {
		const s = await seeded();
		const one = await fetchCached(s.env.DB, ["a"], { kind: "all" }, { now: NOW, id: s.a2.id });
		expect(one).toEqual([s.a2]);
		expect(await fetchCached(s.env.DB, ["b"], { kind: "all" }, { now: NOW, id: s.a2.id })).toEqual([]);
	});

	it("includes scheduled messages only on request", async () => {
		const s = await seeded();
		expect(ids(await fetchCached(s.env.DB, ["a"], { kind: "all" }, { now: NOW, scheduled: true }))).toContain(s.later.id);
	});

	it("delivers due scheduled messages exactly once and prunes expired ones", async () => {
		const s = await seeded();
		expect(await claimDueMessages(s.env.DB, NOW)).toEqual([]);
		expect(ids(await claimDueMessages(s.env.DB, NOW + 600))).toEqual([s.later.id]);
		expect(await claimDueMessages(s.env.DB, NOW + 700)).toEqual([]);
		expect(await pruneExpired(s.env.DB, NOW)).toBe(1);
	});
});
