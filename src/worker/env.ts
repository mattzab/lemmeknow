export interface Env {
	DB: D1Database;
	ASSETS: Fetcher;
	/** Public base URL of this deployment, no trailing slash (e.g. https://lemmeknow.example.com). */
	BASE_URL: string;
	ACCESS_TEAM_DOMAIN: string;
	/** AUD tag of the Access application protecting /admin and /api/admin. */
	ACCESS_AUD: string;
	/** How long messages stay in the inbox, in seconds. */
	RETENTION_SECONDS: string;
	/** Optional VAPID contact (`mailto:` or `https:`). Defaults to BASE_URL. */
	VAPID_SUBJECT: string;
}

export const VERSION = "0.2.0";
