import type { MessageEvent, NtfyMessage } from "@shared/types";
import { newMessageId, nowSec } from "./util";

export const EMPTY_MESSAGE_BODY = "triggered";
export const KEEPALIVE_INTERVAL_MS = 45_000;

export function newMessage(event: MessageEvent, topic: string, message = "", time = nowSec()): NtfyMessage {
	return { id: newMessageId(), time, event, topic, ...(message ? { message } : {}) };
}

/** Field order and omitempty rules of ntfy's model.Message JSON encoding. */
export function toWire(m: NtfyMessage): Record<string, unknown> {
	const o: Record<string, unknown> = { id: m.id, time: m.time };
	if (m.expires) o.expires = m.expires;
	o.event = m.event;
	o.topic = m.topic;
	if (m.title) o.title = m.title;
	if (m.message) o.message = m.message;
	if (m.priority) o.priority = m.priority;
	if (m.tags?.length) o.tags = m.tags;
	if (m.click) o.click = m.click;
	if (m.icon) o.icon = m.icon;
	if (m.actions?.length) o.actions = m.actions;
	if (m.attachment) o.attachment = m.attachment;
	if (m.poll_id) o.poll_id = m.poll_id;
	if (m.content_type) o.content_type = m.content_type;
	if (m.encoding) o.encoding = m.encoding;
	return o;
}

export const toJSONString = (m: NtfyMessage) => JSON.stringify(toWire(m));

export type StreamFormat = "json" | "sse" | "raw";

export const CONTENT_TYPES: Record<StreamFormat, string> = {
	json: "application/x-ndjson; charset=utf-8",
	sse: "text/event-stream; charset=utf-8",
	raw: "text/plain; charset=utf-8",
};

/** Encode one event the way ntfy's /json, /sse and /raw endpoints do. */
export function encode(format: StreamFormat, m: NtfyMessage): string {
	switch (format) {
		case "json":
			return toJSONString(m) + "\n";
		case "sse":
			if (m.event !== "message") return `event: ${m.event}\ndata: ${toJSONString(m)}\n\n`;
			return `data: ${toJSONString(m)}\n\n`;
		case "raw":
			if (m.event === "message") return (m.message ?? "").replaceAll("\n", " ") + "\n";
			return "\n";
	}
}
