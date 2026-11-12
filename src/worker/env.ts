import type { Hub } from "./hub";

export interface Env {
	DB: D1Database;
	HUB: DurableObjectNamespace<Hub>;
	ASSETS: Fetcher;
	/** Public base URL the apps are configured with, no trailing slash (e.g. https://ntfy.example.com). */
	BASE_URL: string;
	ACCESS_TEAM_DOMAIN: string;
	/** AUD tag of the Access application protecting /admin and /api/admin. */
	ACCESS_AUD: string;
	/** ntfy server used for iOS poll_request wakeups, e.g. https://ntfy.sh. Empty disables. */
	UPSTREAM_BASE_URL: string;
	CACHE_DURATION_SECONDS: string;
	/** Optional secret: Bearer token for the upstream server (higher rate limits). */
	UPSTREAM_ACCESS_TOKEN?: string;
}

export const VERSION = "0.1.0";
