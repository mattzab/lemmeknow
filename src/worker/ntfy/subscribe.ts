import type { NtfyMessage } from "@shared/types";
import { E } from "./errors";
import { isMessageId, nowSec, type Params, parseDurationSeconds, parsePriority, splitNoEmpty, TOPIC_RE } from "./util";

export type Since = { kind: "all" } | { kind: "none" } | { kind: "latest" } | { kind: "time"; time: number } | { kind: "id"; id: string };

export interface Filters {
	id?: string;
	message?: string;
	title?: string;
	tags?: string[];
	priority?: number[];
}

export interface SubscribeParams {
	poll: boolean;
	since: Since;
	scheduled: boolean;
	filters: Filters;
}

/** ntfy parseSubscribeParams + parseSince + parseQueryFilters. */
export function parseSubscribeParams(p: Params, now = nowSec()): SubscribeParams {
	const poll = p.bool(false, "x-poll", "poll", "po");
	const scheduled = p.bool(false, "x-scheduled", "scheduled", "sched");
	const since = parseSince(p.get("x-since", "since", "si"), poll, now);
	const filters: Filters = {};
	const id = p.get("x-id", "id");
	if (id) filters.id = id;
	const message = p.get("x-message", "message", "m");
	if (message) filters.message = message;
	const title = p.get("x-title", "title", "t");
	if (title) filters.title = title;
	const tags = splitNoEmpty(p.get("x-tags", "tags", "tag", "ta"), ",").map((t) => t.trim());
	if (tags.length) filters.tags = tags;
	const prios = splitNoEmpty(p.get("x-priority", "priority", "prio", "p"), ",").map((x) => {
		const n = parsePriority(x);
		if (n == null) throw E.priorityInvalid;
		return n;
	});
	if (prios.length) filters.priority = prios;
	return { poll, since, scheduled, filters };
}

export function parseSince(since: string, poll: boolean, now = nowSec()): Since {
	if (!since) return poll ? { kind: "all" } : { kind: "none" };
	if (since === "all") return { kind: "all" };
	if (since === "latest") return { kind: "latest" };
	if (since === "none") return { kind: "none" };
	if (isMessageId(since)) return { kind: "id", id: since };
	if (/^-?\d+$/.test(since)) return { kind: "time", time: Number(since) };
	const d = parseDurationSeconds(since);
	if (d != null) return { kind: "time", time: Math.floor(now - d) };
	throw E.sinceInvalid;
}

/** ntfy queryFilter.Pass: filters apply to message events only. */
export function passesFilters(f: Filters, m: NtfyMessage): boolean {
	if (m.event !== "message") return true;
	if (f.id && m.id !== f.id) return false;
	if (f.message && m.message !== f.message) return false;
	if (f.title && m.title !== f.title) return false;
	const prio = m.priority || 3;
	if (f.priority?.length && !f.priority.includes(prio)) return false;
	if (f.tags?.length && !f.tags.every((t) => m.tags?.includes(t))) return false;
	return true;
}

/** Topics from a subscribe path like "/a,b/json". Throws on invalid names. */
export function topicsFromPath(segment: string): string[] {
	const topics = segment.split(",");
	if (!topics.length || topics.some((t) => !TOPIC_RE.test(t))) throw E.topicInvalid;
	return [...new Set(topics)];
}
