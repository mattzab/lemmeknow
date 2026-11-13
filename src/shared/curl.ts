/**
 * The short publish URL, `<base>/<token>/<topic>`, and copy-ready curl commands for it.
 * Shared by the dashboard, the web app and tests so all three agree on the format.
 */

/** First path segment that is treated as a token: `lk_…` (or `tk_…` from 0.1). */
export const URL_TOKEN_RE = /^(?:lk|tk)_[A-Za-z0-9]{4,128}$/;

export interface PublishOptions {
	title?: string;
	body?: string;
	url?: string;
	priority?: number | string;
	tags?: string;
}

const enc = encodeURIComponent;

function query(o: PublishOptions, withBody: boolean): string {
	const parts: string[] = [];
	const add = (k: string, v: string | number | undefined) => {
		const s = v === undefined ? "" : String(v).trim();
		if (s) parts.push(`${k}=${enc(s)}`);
	};
	add("title", o.title);
	if (withBody) add("body", o.body);
	add("url", o.url);
	if (o.priority !== undefined && String(o.priority) !== "3") add("priority", o.priority);
	add("tags", o.tags);
	return parts.length ? `?${parts.join("&")}` : "";
}

/** `<base>/<token>/<topic>` with no options. */
export const publishUrl = (base: string, token: string, topic: string) => `${base.replace(/\/+$/, "")}/${enc(token)}/${enc(topic)}`;

/** URL with every option (body included) in the query string: works for a plain GET. */
export const publishGetUrl = (base: string, token: string, topic: string, o: PublishOptions = {}) => publishUrl(base, token, topic) + query(o, true);

/** POSIX shell quoting: bare when safe, else single quotes. */
export function shq(s: string): string {
	if (/^[A-Za-z0-9_\/:.,@%+=-]+$/.test(s)) return s;
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

const CURL = "curl -fsS -m 10 --retry 3";

/** POST: the message as the body, other options in the query. */
export function curlPost(base: string, token: string, topic: string, o: PublishOptions = {}): string {
	const url = publishUrl(base, token, topic) + query(o, false);
	const body = (o.body ?? "").trim();
	return body ? `${CURL} --data-raw ${shq(body)} \\\n  ${shq(url)}` : `${CURL} ${shq(url)}`;
}

/** GET: everything in the URL, for cron jobs and uptime tools that can only fetch a URL. */
export const curlGet = (base: string, token: string, topic: string, o: PublishOptions = {}) => `${CURL} ${shq(publishGetUrl(base, token, topic, o))}`;
