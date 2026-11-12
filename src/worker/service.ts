import type { NtfyMessage } from "@shared/types";
import { type Env, VERSION } from "./env";
import { hub } from "./hub";
import type { ParsedPublish } from "./ntfy/publish";
import { forwardPollRequest } from "./ntfy/upstream";
import { normalizeBaseUrl, nowSec } from "./ntfy/util";
import { claimDueMessages, insertMessage, pruneExpired, touchTopicStmt } from "./store";

export const cacheDurationSeconds = (env: Env) => {
	const n = Number(env.CACHE_DURATION_SECONDS);
	return Number.isFinite(n) && n > 0 ? n : 43200;
};

/** The base URL the apps were configured with; falls back to the request origin. */
export const baseUrlFor = (env: Env, req?: Request) => normalizeBaseUrl(env.BASE_URL || (req ? new URL(req.url).origin : ""));

type WaitUntil = (p: Promise<unknown>) => void;

/** Store, fan out, and (for iOS) wake the upstream server. */
export async function deliver(env: Env, waitUntil: WaitUntil, p: ParsedPublish, baseUrl: string): Promise<void> {
	const now = nowSec();
	const m = p.message;
	if (p.delayed) {
		await insertMessage(env.DB, m, false, now);
		return;
	}
	if (p.cache) await insertMessage(env.DB, m, true, now);
	else await touchTopicStmt(env.DB, m.topic, now).run();
	await fanOut(env, waitUntil, m, baseUrl, p.upstream && p.cache);
}

async function fanOut(env: Env, waitUntil: WaitUntil, m: NtfyMessage, baseUrl: string, upstream: boolean) {
	try {
		await hub(env).broadcast(m);
	} catch (e) {
		console.error("hub broadcast failed", (e as Error).message);
	}
	if (upstream && env.UPSTREAM_BASE_URL && baseUrl) {
		waitUntil(
			forwardPollRequest({ baseUrl, upstreamBaseUrl: env.UPSTREAM_BASE_URL, accessToken: env.UPSTREAM_ACCESS_TOKEN, userAgent: `lemmeknow/${VERSION}` }, m),
		);
	}
}

/** Cron: deliver scheduled messages that are due, then drop expired ones. */
export async function runScheduled(env: Env, waitUntil: WaitUntil): Promise<{ delivered: number; pruned: number }> {
	const now = nowSec();
	const due = await claimDueMessages(env.DB, now);
	const baseUrl = baseUrlFor(env);
	for (const m of due) await fanOut(env, waitUntil, m, baseUrl, m.event === "message" && !m.encoding);
	const pruned = await pruneExpired(env.DB, now);
	return { delivered: due.length, pruned };
}
