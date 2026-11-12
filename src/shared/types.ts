/** Wire types shared by the Worker and the dashboard. Field names follow ntfy's JSON API. */

export type MessageEvent = "open" | "keepalive" | "message" | "poll_request";

export interface NtfyAction {
	id: string;
	action: "view" | "broadcast" | "http" | "copy";
	label: string;
	clear: boolean;
	url?: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	intent?: string;
	extras?: Record<string, string>;
	value?: string;
}

export interface NtfyAttachment {
	name: string;
	type?: string;
	size?: number;
	expires?: number;
	url: string;
}

/** A message as ntfy serializes it (see binwiederhier/ntfy model.Message). */
export interface NtfyMessage {
	id: string;
	time: number;
	expires?: number;
	event: MessageEvent;
	topic: string;
	title?: string;
	message?: string;
	priority?: number;
	tags?: string[];
	click?: string;
	icon?: string;
	actions?: NtfyAction[];
	attachment?: NtfyAttachment;
	poll_id?: string;
	content_type?: string;
	encoding?: string;
}

export interface Grant {
	/** Topic name or pattern with `*` wildcards (e.g. `alerts_*`, `*`). */
	topic: string;
	read: boolean;
	write: boolean;
}

export interface TokenInfo {
	id: string;
	label: string;
	prefix: string;
	grants: Grant[];
	created_at: number;
	last_used_at: number | null;
	expires_at: number | null;
}

export interface TopicInfo {
	name: string;
	description: string;
	anon_read: boolean;
	anon_write: boolean;
	created_at: number;
	last_message_at: number | null;
	message_count: number;
	cached: number;
	subscribers: number;
}

export interface ServerInfo {
	baseUrl: string;
	upstreamBaseUrl: string;
	upstreamEnabled: boolean;
	cacheDurationSeconds: number;
	email: string;
	version: string;
}

export interface StoredMessage extends NtfyMessage {
	published: boolean;
}
