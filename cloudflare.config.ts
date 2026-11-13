import { existsSync, readFileSync } from "node:fs";
import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Deployment settings live outside git so a fork never commits its owner's domains or ids.
 * Copy `lemmeknow.config.example.json` to `lemmeknow.config.json` (gitignored) and fill it in,
 * or set the matching LEMMEKNOW_* environment variables (they win over the file).
 * See README → Deploy your own.
 */
type LemmeknowConfig = {
	/** Cloudflare account id. */
	accountId: string;
	/** Hostname the Worker serves, e.g. lemmeknow.example.com (a zone on your account). */
	host: string;
	/** Public base URL (no trailing slash). Defaults to https://<host>. */
	baseUrl?: string;
	/** Cloudflare Access team domain, e.g. your-team.cloudflareaccess.com. */
	accessTeamDomain: string;
	/** AUD tag of the Access application that protects /admin and /api/admin. */
	accessAud: string;
	/** How long messages stay in the inbox, in days (default 7). */
	retentionDays?: string;
	/** Optional VAPID contact for push services: mailto:you@example.com or an https URL. Defaults to baseUrl. */
	vapidSubject?: string;
	/** Owner e-mails (comma separated), always admins. Keep them in the gitignored config file. */
	adminEmails?: string;
};

const FILE = new URL("./lemmeknow.config.json", import.meta.url);
const file: Partial<LemmeknowConfig> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const env = (k: string) => process.env[k] ?? undefined;
const host = env("LEMMEKNOW_HOST") ?? file.host ?? "lemmeknow.example.com";
const cfg: LemmeknowConfig = {
	accountId: env("LEMMEKNOW_ACCOUNT_ID") ?? file.accountId ?? "",
	host,
	baseUrl: env("LEMMEKNOW_BASE_URL") ?? file.baseUrl ?? `https://${host}`,
	accessTeamDomain: env("LEMMEKNOW_ACCESS_TEAM_DOMAIN") ?? file.accessTeamDomain ?? "your-team.cloudflareaccess.com",
	accessAud: env("LEMMEKNOW_ACCESS_AUD") ?? file.accessAud ?? "",
	retentionDays: env("LEMMEKNOW_RETENTION_DAYS") ?? file.retentionDays ?? "7",
	vapidSubject: env("LEMMEKNOW_VAPID_SUBJECT") ?? file.vapidSubject ?? "",
	adminEmails: env("LEMMEKNOW_ADMIN_EMAILS") ?? file.adminEmails ?? "",
};
if (!existsSync(FILE) && !env("LEMMEKNOW_ACCOUNT_ID")) {
	console.warn("[lemmeknow] No lemmeknow.config.json found; using example.com placeholders (fine for `cf dev`, not for deploy).");
}
const retentionSeconds = Math.round((Number(cfg.retentionDays) > 0 ? Number(cfg.retentionDays) : 7) * 86400);

export default defineConfig({
	...(cfg.accountId ? { accountId: cfg.accountId } : {}),
	worker: {
		name: "lemmeknow",
		compatibilityDate: "2026-11-10",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		observability: { enabled: true, traces: { enabled: true } },
		assets: {
			notFoundHandling: "single-page-application",
			// The PWA (/, /sw.js, manifest, icons, /assets/*) is plain static content. The Worker runs
			// only for the APIs, the Access-gated dashboard, and the health probe.
			runWorkerFirst: ["/api/*", "/admin", "/admin/*", "/admin.html", "/login", "/access/*", "/healthz", "/lk_*", "/tk_*"],
		},
		domains: [cfg.host],
		workersDev: false,
		previewUrls: false,
		// Hourly: drop inbox rows whose messages have all expired.
		triggers: [triggers.scheduled({ schedule: "17 * * * *" })],
		env: {
			DB: bindings.d1({ name: "lemmeknow-db" }),
			ASSETS: bindings.assets(),
			BASE_URL: bindings.text(cfg.baseUrl ?? ""),
			ACCESS_TEAM_DOMAIN: bindings.text(cfg.accessTeamDomain),
			// AUD tag of the dashboard's Access application (not a secret).
			ACCESS_AUD: bindings.text(cfg.accessAud),
			RETENTION_SECONDS: bindings.text(String(retentionSeconds)),
			VAPID_SUBJECT: bindings.text(cfg.vapidSubject ?? ""),
			ADMIN_EMAILS: bindings.text(cfg.adminEmails ?? ""),
			// No secrets: the VAPID key pair is generated on first use and kept in D1.
		},
	},
});
