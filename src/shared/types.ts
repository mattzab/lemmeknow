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
	/** The full token, always copyable. null for tokens created before 0.3 (only a hash was kept): replace those. */
	token: string | null;
	grants: Grant[];
	/** The user this token belongs to (null for tokens not tied to a person, e.g. a script). */
	user_email: string | null;
	/** A user's personal token: what the signed-in web app uses. Its grants follow the user's. */
	personal: boolean;
	created_at: number;
	last_used_at: number | null;
	expires_at: number | null;
}

export type Role = "admin" | "member";

export interface UserInfo {
	email: string;
	role: Role;
	/** Topic grants for members. Admins can read and write every topic. */
	grants: Grant[];
	/** "config": an owner listed in adminEmails (cannot be removed from the dashboard). */
	source: "config" | "dashboard";
	created_at: number | null;
	added_by: string | null;
	tokens: number;
}

/** The signed-in person, as the web app sees them (GET /api/me). */
export interface MeInfo {
	email: string;
	role: Role;
	/** Personal token for the web app and for curl. Always the full value. */
	token: string;
	grants: Grant[];
	/** Topics this person can read, with whether they can publish to each. */
	topics: { name: string; description: string; can_write: boolean }[];
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
	/** Owners from adminEmails config (empty: first signed-in person bootstraps as admin). */
	configAdmins: string[];
	/** Public URLs to paste into the Access policy's External Evaluation rule. */
	accessEvaluateUrl: string;
	accessKeysUrl: string;
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
