import { authorize } from "./auth";
import { type Env, VERSION } from "./env";
import { E, NtfyError } from "./ntfy/errors";
import type { StreamFormat } from "./ntfy/message";
import { jsonPublishToRequest, parsePublish } from "./ntfy/publish";
import { parseSubscribeParams, topicsFromPath } from "./ntfy/subscribe";
import { isValidTopic, nowSec, Params, TOPIC_RE } from "./ntfy/util";
import { baseUrlFor, cacheDurationSeconds, deliver } from "./service";
import { countMessages } from "./store";
import { subscribeHttp, subscribeWs } from "./streams";
import { toWire } from "./ntfy/message";

/** Largest request body accepted at all (message bodies are capped at 4 KB after parsing). */
const BODY_LIMIT = 64 * 1024;

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(data) + "\n", { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...headers } });

type Ctx = { waitUntil(p: Promise<unknown>): void };

/**
 * The ntfy HTTP API (the subset the official apps and curl use). Returns null for paths that
 * are not part of it, so the caller can serve the dashboard or a 404.
 */
export async function handleNtfy(req: Request, env: Env, ctx: Ctx): Promise<Response | null> {
	try {
		return await route(req, env, ctx);
	} catch (e) {
		if (e instanceof NtfyError) return e.toResponse();
		console.error("ntfy handler error", (e as Error).stack ?? e);
		return E.internal.toResponse();
	}
}

async function route(req: Request, env: Env, ctx: Ctx): Promise<Response | null> {
	const url = new URL(req.url);
	const path = url.pathname;
	const method = req.method;

	if (method === "OPTIONS") {
		return new Response(null, {
			status: 200,
			headers: { "access-control-allow-methods": "GET, PUT, POST, PATCH, DELETE", "access-control-allow-origin": "*", "access-control-allow-headers": "*" },
		});
	}
	if (method === "GET" && path === "/v1/health") return json({ healthy: true });
	if (method === "GET" && path === "/v1/config") return json(configResponse());
	if (method === "GET" && path === "/v1/stats") return json({ messages: await countMessages(env.DB, nowSec()), messages_rate: 0 });
	if (method === "HEAD" && path === "/") return new Response(null, { status: 200 });

	// Publish as JSON: PUT/POST / {"topic": "...", "message": "..."}
	if ((method === "PUT" || method === "POST") && path === "/") {
		const body = await readBody(req);
		const j = jsonPublishToRequest(new TextDecoder().decode(body), url.searchParams);
		return publish(req, env, ctx, j.topic, j.params, j.body);
	}

	const parts = path.split("/").slice(1);
	if (parts.length === 1 && TOPIC_RE.test(parts[0])) {
		const topic = parts[0];
		if (method === "PUT" || method === "POST") {
			if (!isValidTopic(topic)) return null;
			return publish(req, env, ctx, topic, Params.from(req), await readBody(req));
		}
		if (method === "GET" && isValidTopic(topic)) {
			if (new Params(req.headers, url.searchParams).bool(false, "x-unifiedpush", "unifiedpush", "up")) return json({ unifiedpush: { version: 1 } });
			return new Response(`This is a Lemmeknow topic. Subscribe to it with the ntfy app using this server's URL and a token.\n`, {
				headers: { "content-type": "text/plain; charset=utf-8" },
			});
		}
		return null;
	}
	if (parts.length === 2 && method === "GET") {
		const [seg, action] = parts;
		if (["publish", "send", "trigger"].includes(action) && TOPIC_RE.test(seg)) {
			if (!isValidTopic(seg)) return null;
			return publish(req, env, ctx, seg, Params.from(req), new Uint8Array());
		}
		if (["json", "sse", "raw", "ws", "auth"].includes(action)) {
			let topics: string[];
			try {
				topics = topicsFromPath(seg);
			} catch {
				return null;
			}
			if (topics.some((t) => !isValidTopic(t))) return null;
			await authorize(env.DB, req, topics, "read", nowSec(), (p) => ctx.waitUntil(p));
			if (action === "auth") return json({ success: true });
			const sp = parseSubscribeParams(Params.from(req));
			if (action === "ws") return subscribeWs(req, env, topics, sp);
			return subscribeHttp(env, topics, action as StreamFormat, sp);
		}
	}
	return null;
}

async function readBody(req: Request): Promise<Uint8Array> {
	const len = Number(req.headers.get("content-length") ?? "0");
	if (len > BODY_LIMIT) throw E.tooLarge;
	const buf = new Uint8Array(await req.arrayBuffer());
	if (buf.length > BODY_LIMIT) throw E.tooLarge;
	return buf;
}

async function publish(req: Request, env: Env, ctx: Ctx, topic: string, params: Params, body: Uint8Array): Promise<Response> {
	if (!isValidTopic(topic)) throw E.topicInvalid;
	await authorize(env.DB, req, [topic], "write", nowSec(), (p) => ctx.waitUntil(p));
	const parsed = parsePublish(params, topic, body, { cacheDurationSeconds: cacheDurationSeconds(env) });
	await deliver(env, (p) => ctx.waitUntil(p), parsed, baseUrlFor(env, req));
	return json(toWire(parsed.message));
}

/** GET /v1/config, in ntfy's apiConfigResponse shape: no accounts, signup, payments, e-mail or calls. */
export function configResponse() {
	return {
		base_url: "",
		app_root: "/admin",
		enable_login: false,
		require_login: false,
		enable_signup: false,
		enable_payments: false,
		enable_calls: false,
		enable_emails: false,
		enable_reset_password: false,
		enable_reservations: false,
		enable_web_push: false,
		billing_contact: "",
		web_push_public_key: "",
		disallowed_topics: [] as string[],
		config_hash: `lemmeknow-${VERSION}`,
	};
}

