import type { NtfyAttachment, NtfyMessage } from "@shared/types";
import { parseActions } from "./actions";
import { E } from "./errors";
import { EMPTY_MESSAGE_BODY, newMessage } from "./message";
import { isValidTopic, nowSec, Params, parseFutureTime, parsePriority } from "./util";

export const MESSAGE_SIZE_LIMIT = 4096;
const TITLE_SIZE_LIMIT = 1024;
const TAGS_SIZE_LIMIT = 512;
export const DELAY_MIN_SECONDS = 10;
export const DELAY_MAX_SECONDS = 3 * 24 * 3600;
const URL_RE = /^https?:\/\//;

export interface PublishOptions {
	cacheDurationSeconds: number;
	now?: number;
}

export interface ParsedPublish {
	message: NtfyMessage;
	/** Store in the cache (D1) so clients can poll it later. */
	cache: boolean;
	/** Forward an iOS poll_request wakeup upstream. */
	upstream: boolean;
	/** message.time is in the future: deliver later from the cron. */
	delayed: boolean;
}

/**
 * Turn a publish request (headers, query and body) into a message, following ntfy's
 * parsePublishParams + handlePublishBody. Throws NtfyError on invalid input.
 */
export function parsePublish(p: Params, topic: string, body: Uint8Array, opts: PublishOptions): ParsedPublish {
	if (!isValidTopic(topic)) throw E.topicInvalid;
	const now = opts.now ?? nowSec();
	const m = newMessage("message", topic, "", now);

	let cache = p.bool(true, "x-cache", "cache");
	m.title = p.get("x-title", "title", "t") || undefined;
	if ((m.title?.length ?? 0) > TITLE_SIZE_LIMIT) throw E.titleTooLarge;
	m.click = p.get("x-click", "click") || undefined;

	const icon = p.get("x-icon", "icon");
	const filename = p.get("x-filename", "filename", "file", "f");
	const attach = p.get("x-attach", "attach", "a");
	let attachment: NtfyAttachment | undefined;
	if (attach || filename) attachment = { name: filename, url: "" };
	if (attach && attachment) {
		if (!URL_RE.test(attach)) throw E.attachmentUrlInvalid;
		attachment.url = attach;
		if (!attachment.name) {
			try {
				const base = new URL(attach).pathname.split("/").filter(Boolean).pop() ?? "";
				attachment.name = decodeURIComponent(base);
			} catch {
				attachment.name = "";
			}
		}
		if (!attachment.name) attachment.name = "attachment";
	}
	if (icon) {
		if (!URL_RE.test(icon)) throw E.iconUrlInvalid;
		m.icon = icon;
	}

	const email = p.get("x-email", "x-e-mail", "email", "e-mail", "mail", "e");
	if (email) throw E.emailUnsupported;
	const call = p.get("x-call", "call");
	if (call) throw E.callUnsupported;

	let messageStr = p.get("x-message", "message", "m");
	messageStr = messageStr.replaceAll("\\n", "\n");
	if (messageStr) m.message = messageStr;

	const priority = parsePriority(p.get("x-priority", "priority", "prio", "p"));
	if (priority == null) throw E.priorityInvalid;
	if (priority) m.priority = priority;

	const tags = p.list("x-tags", "tags", "tag", "ta");
	if (tags.join("").length > TAGS_SIZE_LIMIT) throw E.tagsTooLarge;
	if (tags.length) m.tags = tags;

	const delayStr = p.get("x-delay", "delay", "x-at", "at", "x-in", "in");
	if (delayStr) {
		if (!cache) throw E.delayNoCache;
		const at = parseFutureTime(delayStr, now);
		if (at == null) throw E.delayCannotParse;
		if (at < now + DELAY_MIN_SECONDS) throw E.delayTooSmall;
		if (at > now + DELAY_MAX_SECONDS) throw E.delayTooLarge;
		m.time = at;
	}

	const actionsStr = p.get("x-actions", "actions", "action");
	if (actionsStr) {
		try {
			m.actions = parseActions(actionsStr);
		} catch (e) {
			throw E.actionsInvalid.withDetail((e as Error).message);
		}
	}

	const contentType = p.get("content-type", "content_type");
	const markdown = p.bool(false, "x-markdown", "markdown", "md");
	if (markdown || /^text\/markdown/i.test(contentType)) m.content_type = "text/markdown";

	let unifiedpush = p.bool(false, "x-unifiedpush", "unifiedpush", "up");
	if (p.get("content-encoding") === "aes128gcm") unifiedpush = true;

	const pollId = p.get("x-poll-id", "poll-id");

	// Body handling (ntfy handlePublishBody)
	let msg: NtfyMessage = m;
	if (pollId) {
		msg = newMessage("poll_request", topic, "New message", now);
		msg.poll_id = pollId;
		cache = false;
		unifiedpush = false;
	} else if (unifiedpush) {
		const text = utf8(body);
		if (text != null) m.message = text;
		else {
			m.message = base64(body);
			m.encoding = "base64";
		}
	} else if (attachment?.url) {
		const text = utf8(body.subarray(0, MESSAGE_SIZE_LIMIT));
		if (text == null) throw E.messageNotUtf8;
		if (text.trim()) m.message = text.trim();
		m.attachment = attachment;
		if (!m.message) m.message = `You received a file: ${attachment.name}`;
	} else if (attachment?.name) {
		throw E.attachmentsDisallowed.withDetail("file uploads are not supported yet; use Attach with a URL");
	} else {
		const text = body.length <= MESSAGE_SIZE_LIMIT ? utf8(body) : null;
		if (text == null) throw E.attachmentsDisallowed.withDetail(`message must be UTF-8 text up to ${MESSAGE_SIZE_LIMIT} bytes`);
		if (text.length > 0) m.message = text.trim();
	}
	if (!msg.message) msg.message = EMPTY_MESSAGE_BODY;
	if (cache) msg.expires = msg.time + opts.cacheDurationSeconds;
	return { message: msg, cache, upstream: !unifiedpush && msg.event === "message", delayed: msg.time > now };
}

/**
 * Publishing as JSON (`PUT /` with {"topic": ...}): ntfy rewrites the request into headers and
 * a plain body, then publishes normally. We do the same.
 */
export function jsonPublishToRequest(bodyText: string, query = new URLSearchParams()): { topic: string; params: Params; body: Uint8Array } {
	let j: Record<string, unknown>;
	try {
		j = JSON.parse(bodyText);
	} catch {
		throw E.messageJsonInvalid;
	}
	if (!j || typeof j !== "object" || Array.isArray(j)) throw E.messageJsonInvalid;
	const topic = typeof j.topic === "string" ? j.topic : "";
	if (!isValidTopic(topic)) throw E.topicInvalid;
	const h = new Headers();
	const str = (k: string) => (typeof j[k] === "string" ? (j[k] as string) : "");
	if (str("title")) h.set("X-Title", str("title"));
	if (typeof j.priority === "number" && j.priority !== 0) h.set("X-Priority", String(j.priority));
	if (Array.isArray(j.tags) && j.tags.length) h.set("X-Tags", j.tags.map(String).join(","));
	if (str("attach")) h.set("X-Attach", str("attach"));
	if (str("filename")) h.set("X-Filename", str("filename"));
	if (str("click")) h.set("X-Click", str("click"));
	if (str("icon")) h.set("X-Icon", str("icon"));
	if (j.markdown === true) h.set("X-Markdown", "yes");
	if (Array.isArray(j.actions) && j.actions.length) h.set("X-Actions", JSON.stringify(j.actions));
	if (str("email")) h.set("X-Email", str("email"));
	if (str("call")) h.set("X-Call", str("call"));
	if (str("delay")) h.set("X-Delay", str("delay"));
	if (str("cache")) h.set("X-Cache", str("cache"));
	const message = str("message") || EMPTY_MESSAGE_BODY;
	return { topic, params: new Params(h, query), body: new TextEncoder().encode(message) };
}

function utf8(b: Uint8Array): string | null {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(b);
	} catch {
		return null;
	}
}

function base64(b: Uint8Array): string {
	let bin = "";
	for (const x of b) bin += String.fromCharCode(x);
	return btoa(bin);
}
