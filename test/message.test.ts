import { describe, expect, it } from "vitest";
import type { NtfyMessage } from "../src/shared/types";
import { encode, newMessage, toJSONString, toWire } from "../src/worker/ntfy/message";

const full: NtfyMessage = {
	encoding: "base64",
	content_type: "text/markdown",
	poll_id: "p",
	attachment: { name: "a.jpg", url: "https://x/a.jpg" },
	actions: [{ id: "a1", action: "view", label: "L", clear: false, url: "https://x" }],
	icon: "https://x/i.png",
	click: "https://x",
	tags: ["t"],
	priority: 4,
	message: "body",
	title: "T",
	topic: "mytopic",
	event: "message",
	expires: 200,
	time: 100,
	id: "abcdefghijkl",
};

describe("message JSON", () => {
	it("uses ntfy's field order", () => {
		expect(Object.keys(toWire(full))).toEqual([
			"id",
			"time",
			"expires",
			"event",
			"topic",
			"title",
			"message",
			"priority",
			"tags",
			"click",
			"icon",
			"actions",
			"attachment",
			"poll_id",
			"content_type",
			"encoding",
		]);
	});

	it("omits empty fields like Go's omitempty", () => {
		const open = newMessage("open", "a,b", "", 123);
		expect(Object.keys(toWire(open))).toEqual(["id", "time", "event", "topic"]);
		expect(toWire({ ...open, tags: [], priority: 0, message: "" })).not.toHaveProperty("tags");
	});

	it("encodes /json as NDJSON", () => {
		expect(encode("json", full)).toBe(toJSONString(full) + "\n");
	});

	it("encodes /sse with an event line for non-message events only", () => {
		expect(encode("sse", full)).toBe(`data: ${toJSONString(full)}\n\n`);
		const ka = newMessage("keepalive", "mytopic", "", 1);
		expect(encode("sse", ka)).toBe(`event: keepalive\ndata: ${toJSONString(ka)}\n\n`);
	});

	it("encodes /raw as one line per message and blank lines otherwise", () => {
		expect(encode("raw", { ...full, message: "a\nb" })).toBe("a b\n");
		expect(encode("raw", newMessage("open", "x"))).toBe("\n");
	});
});
