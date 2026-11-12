import type { NtfyMessage } from "@shared/types";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { KEEPALIVE_INTERVAL_MS, newMessage, toJSONString } from "./ntfy/message";
import { type Filters, parseSubscribeParams, passesFilters } from "./ntfy/subscribe";
import { nowSec, Params } from "./ntfy/util";
import { fetchCached } from "./store";

/**
 * Fan-out hub: one Durable Object holds every live subscriber as a hibernatable WebSocket.
 *
 * - "client" sockets are the ntfy apps' own `/…/ws` connections, handed straight to this object
 *   by the Worker (after it authorized them). The hub sends `open`, replays cached messages,
 *   streams new ones (applying the client's query filters) and sends `keepalive` every 45 s.
 * - "bridge" sockets come from the Worker itself, which turns them into `/json`, `/sse` and
 *   `/raw` HTTP streams; the hub just forwards matching messages and the Worker does the rest.
 *
 * Why a single hub and not one object per topic: the ntfy Android app multiplexes all topics of
 * a server over one connection (`/a,b,c/json`), and a Worker may hold only six open outbound
 * connections per request, so per-topic objects would cap a phone at six topics. One object
 * handles thousands of sockets, far beyond a personal or team server. See docs/DECISIONS.md.
 */

export interface SocketAttachment {
	mode: "client" | "bridge";
	topics: string[];
	filters: Filters;
}

export const HUB_NAME = "hub";

export class Hub extends DurableObject<Env> {
	async fetch(req: Request): Promise<Response> {
		if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected websocket", { status: 426 });
		const url = new URL(req.url);
		const topics = (url.searchParams.get("topics") ?? "").split(",").filter(Boolean);
		if (!topics.length) return new Response("no topics", { status: 400 });
		const mode = url.searchParams.get("mode") === "bridge" ? "bridge" : "client";
		const pair = new WebSocketPair();
		const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
		this.ctx.acceptWebSocket(server, [mode]);

		if (mode === "bridge") {
			server.serializeAttachment({ mode, topics, filters: {} } satisfies SocketAttachment);
			return new Response(null, { status: 101, webSocket: client });
		}

		// Client sockets: the original subscribe query string rides along in `q`.
		const q = new URLSearchParams(url.searchParams.get("q") ?? "");
		const sp = parseSubscribeParams(new Params(new Headers(), q));
		server.serializeAttachment({ mode, topics, filters: sp.filters } satisfies SocketAttachment);
		server.send(toJSONString(newMessage("open", topics.join(","))));
		if (sp.since.kind !== "none") {
			const old = await fetchCached(this.env.DB, topics, sp.since, { scheduled: sp.scheduled, id: sp.filters.id, now: nowSec() });
			for (const m of old) if (passesFilters(sp.filters, m)) server.send(toJSONString(m));
		}
		await this.ensureKeepalive();
		return new Response(null, { status: 101, webSocket: client });
	}

	/** Deliver a published message to every socket subscribed to its topic. Returns the count. */
	async broadcast(m: NtfyMessage): Promise<number> {
		const json = toJSONString(m);
		let n = 0;
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment() as SocketAttachment | null;
			if (!a || !a.topics.includes(m.topic)) continue;
			if (a.mode === "client" && !passesFilters(a.filters, m)) continue;
			try {
				ws.send(json);
				n++;
			} catch {
				// Socket already closing; the runtime cleans it up.
			}
		}
		return n;
	}

	/** Live subscriber counts per topic (bridged HTTP streams and WebSockets alike). */
	async subscriberCounts(): Promise<Record<string, number>> {
		const out: Record<string, number> = {};
		for (const ws of this.ctx.getWebSockets()) {
			const a = ws.deserializeAttachment() as SocketAttachment | null;
			for (const t of a?.topics ?? []) out[t] = (out[t] ?? 0) + 1;
		}
		return out;
	}

	async alarm(): Promise<void> {
		const clients = this.ctx.getWebSockets("client");
		for (const ws of clients) {
			const a = ws.deserializeAttachment() as SocketAttachment | null;
			try {
				ws.send(toJSONString(newMessage("keepalive", (a?.topics ?? []).join(","))));
			} catch {
				// ignore
			}
		}
		if (clients.length) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
	}

	private async ensureKeepalive() {
		if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
	}

	// ntfy ignores anything subscribers send.
	async webSocketMessage(): Promise<void> {}

	async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
		try {
			ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		} catch {
			// already closed
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		try {
			ws.close(1011, "error");
		} catch {
			// already closed
		}
	}
}

export const hub = (env: Env) => env.HUB.get(env.HUB.idFromName(HUB_NAME));
