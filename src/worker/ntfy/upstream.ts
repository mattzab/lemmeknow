import type { NtfyMessage } from "@shared/types";
import { normalizeBaseUrl, sha256Hex } from "./util";

/**
 * iOS wakeups through an upstream ntfy server (normally https://ntfy.sh), exactly as ntfy's
 * server.forwardPollRequest does it:
 *
 *   topicURL   = "<base-url>/<topic>"
 *   topicHash  = hex(sha256(topicURL))
 *   POST <upstream-base-url>/<topicHash>   (empty body)
 *   X-Poll-ID: <message id>
 *   Authorization: Bearer <upstream-access-token>   (only if configured)
 *
 * The official iOS app subscribes (via Firebase/APNs) to the same hash of the server URL it was
 * configured with (ntfy-ios Helpers.swift topicHash, which strips trailing slashes), receives a
 * `poll_request` carrying `poll_id`, then fetches `<base-url>/<topic>/json?poll=1&id=<poll_id>`
 * from this server. Message content never leaves this Worker.
 */
export async function upstreamTopicHash(baseUrl: string, topic: string): Promise<string> {
	return sha256Hex(`${normalizeBaseUrl(baseUrl)}/${topic}`);
}

export interface PollRequest {
	url: string;
	init: RequestInit & { headers: Record<string, string> };
}

export async function buildPollRequest(opts: { baseUrl: string; upstreamBaseUrl: string; accessToken?: string; userAgent: string }, m: NtfyMessage): Promise<PollRequest> {
	const hash = await upstreamTopicHash(opts.baseUrl, m.topic);
	const headers: Record<string, string> = { "User-Agent": opts.userAgent, "X-Poll-ID": m.id };
	if (opts.accessToken) headers.Authorization = `Bearer ${opts.accessToken}`;
	return { url: `${normalizeBaseUrl(opts.upstreamBaseUrl)}/${hash}`, init: { method: "POST", headers, body: "" } };
}

export async function forwardPollRequest(opts: { baseUrl: string; upstreamBaseUrl: string; accessToken?: string; userAgent: string }, m: NtfyMessage, fetcher: typeof fetch = fetch): Promise<boolean> {
	const { url, init } = await buildPollRequest(opts, m);
	try {
		const res = await fetcher(url, { ...init, signal: AbortSignal.timeout(10_000) });
		if (!res.ok) {
			const hint = res.status === 429 ? " (rate limited; consider setting UPSTREAM_ACCESS_TOKEN)" : "";
			console.warn(`upstream poll_request for ${m.id} failed: HTTP ${res.status}${hint}`);
			return false;
		}
		return true;
	} catch (e) {
		console.warn(`upstream poll_request for ${m.id} failed: ${(e as Error).message}`);
		return false;
	}
}
