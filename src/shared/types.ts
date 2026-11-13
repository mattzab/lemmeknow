/** Wire types shared by the Worker, the dashboard, and the PWA. */

export type Priority = 1 | 2 | 3 | 4 | 5;

/** A Lemmeknow notification as stored, listed, and pushed. Times are Unix seconds. */
export interface Message {
	id: string;
	topic: string;
	time: number;
	expires: number;
	title?: string;
	body: string;
	/** Opened when the notification is tapped. */
	url?: string;
	/** 1 (min) to 5 (urgent). 3 is the default. */
	priority: Priority;
	tags?: string[];
}

/** What the service worker receives in each Web Push payload. */
export type PushPayload = Pick<Message, "id" | "topic" | "time" | "title" | "body" | "url" | "priority" | "tags">;

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
	/** Anyone can read (inbox + push subscribe) without a token. Off by default. */
	public_read: boolean;
	/** Anyone can publish without a token. Off by default. */
	public_write: boolean;
	created_at: number;
	last_message_at: number | null;
	message_count: number;
	/** Messages still within the retention window. */
	stored: number;
	/** Web Push subscriptions (devices) on this topic. */
	devices: number;
}

export interface ServerInfo {
	baseUrl: string;
	retentionSeconds: number;
	email: string;
	version: string;
	vapidPublicKey: string;
}

/** `PushSubscription.toJSON()` as the browser produces it. */
export interface PushSubscriptionJSON {
	endpoint: string;
	expirationTime?: number | null;
	keys: { p256dh: string; auth: string };
}

/** Errors from every Lemmeknow API: `{ error, field? }` with a matching HTTP status. */
export interface ApiErrorBody {
	error: string;
	field?: string;
}
