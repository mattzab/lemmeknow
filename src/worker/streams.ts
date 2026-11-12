import type { NtfyMessage } from "@shared/types";
import type { Env } from "./env";
import { hub } from "./hub";
import { E } from "./ntfy/errors";
import { CONTENT_TYPES, encode, KEEPALIVE_INTERVAL_MS, newMessage, type StreamFormat, toJSONString } from "./ntfy/message";
import { type SubscribeParams, passesFilters } from "./ntfy/subscribe";
import { nowSec } from "./ntfy/util";
import { fetchCached } from "./store";

const CORS = { "access-control-allow-origin": "*" };

function cached(env: Env, topics: string[], sp: SubscribeParams) {
	return fetchCached(env.DB, topics, sp.since, { scheduled: sp.scheduled, id: sp.filters.id, now: nowSec() });
}

/** Open a "bridge" WebSocket to the hub that receives every message for `topics`. */
async function openBridge(env: Env, topics: string[]): Promise<WebSocket> {
	const res = await hub(env).fetch(`https://hub/bridge?mode=bridge&topics=${encodeURIComponent(topics.join(","))}`, { headers: { upgrade: "websocket" } });
	const ws = res.webSocket;
	if (!ws) throw new Error(`hub refused bridge: HTTP ${res.status}`);
	ws.accept();
	return ws;
}

/**
 * Live subscription plumbing shared by HTTP streams and multiplexed WebSockets:
 * subscribe first, replay the cache, then flush messages that arrived meanwhile (de-duplicated).
 */
async function live(env: Env, topics: string[], sp: SubscribeParams, emit: (m: NtfyMessage) => boolean, onEnd: () => void) {
	const bridge = await openBridge(env, topics);
	const seen = new Set<string>();
	let replaying = true;
	const pending: NtfyMessage[] = [];
	let ended = false;
	const end = () => {
		if (ended) return;
		ended = true;
		clearInterval(timer);
		try {
			bridge.close(1000, "subscriber gone");
		} catch {
			// already closed
		}
		onEnd();
	};
	const send = (m: NtfyMessage) => {
		if (ended) return;
		if (!emit(m)) end();
	};
	bridge.addEventListener("message", (ev) => {
		let m: NtfyMessage;
		try {
			m = JSON.parse(typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
		} catch {
			return;
		}
		if (!passesFilters(sp.filters, m)) return;
		if (replaying) pending.push(m);
		else if (!seen.has(m.id)) send(m);
	});
	bridge.addEventListener("close", end);
	bridge.addEventListener("error", end);
	const timer = setInterval(() => send(newMessage("keepalive", topics.join(","))), KEEPALIVE_INTERVAL_MS);

	send(newMessage("open", topics.join(",")));
	for (const m of await cached(env, topics, sp)) {
		if (!passesFilters(sp.filters, m)) continue;
		seen.add(m.id);
		send(m);
	}
	replaying = false;
	for (const m of pending) if (!seen.has(m.id)) send(m);
	pending.length = 0;
	return end;
}

/** GET /<topics>/json|sse|raw */
export async function subscribeHttp(env: Env, topics: string[], format: StreamFormat, sp: SubscribeParams): Promise<Response> {
	const headers = { ...CORS, "content-type": CONTENT_TYPES[format], "cache-control": "no-cache", "x-accel-buffering": "no" };
	if (sp.poll) {
		const body = (await cached(env, topics, sp))
			.filter((m) => passesFilters(sp.filters, m))
			.map((m) => encode(format, m))
			.join("");
		return new Response(body, { headers });
	}
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const writer = writable.getWriter();
	const enc = new TextEncoder();
	let open = true;
	const emit = (m: NtfyMessage) => {
		if (!open) return false;
		writer.write(enc.encode(encode(format, m))).catch(() => {
			open = false;
			stop?.();
		});
		return true;
	};
	let stop: (() => void) | undefined;
	stop = await live(env, topics, sp, emit, () => {
		open = false;
		writer.close().catch(() => {});
	});
	return new Response(readable, { headers });
}

/**
 * GET /<topics>/ws. A plain live subscription is handed straight to the hub, which keeps it as a
 * hibernatable WebSocket. Polls are answered here and closed.
 */
export async function subscribeWs(req: Request, env: Env, topics: string[], sp: SubscribeParams): Promise<Response> {
	if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") throw E.wsUpgradeMissing;
	if (!sp.poll) {
		const q = new URL(req.url).search.replace(/^\?/, "");
		const url = `https://hub/ws?mode=client&topics=${encodeURIComponent(topics.join(","))}&q=${encodeURIComponent(q)}`;
		return hub(env).fetch(url, { headers: { upgrade: "websocket" } });
	}
	const pair = new WebSocketPair();
	const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
	server.accept();
	for (const m of await cached(env, topics, sp)) if (passesFilters(sp.filters, m)) server.send(toJSONString(m));
	server.close(1000, "poll complete");
	return new Response(null, { status: 101, webSocket: client });
}
