import { existsSync, readFileSync } from "node:fs";
import { bindings, defineConfig, exports, triggers } from "cf/config";
import * as entrypoint from "./src/worker/index.ts" with { type: "cf-worker" };

/**
 * Deployment settings live outside git so a fork never commits its owner's domains or ids.
 * Copy `lemmeknow.config.example.json` to `lemmeknow.config.json` (gitignored) and fill it in,
 * or set the matching LEMMEKNOW_* environment variables (they win over the file).
 * See README → Configuration.
 */
type LemmeknowConfig = {
	/** Cloudflare account id. */
	accountId: string;
	/** Hostname the Worker serves, e.g. ntfy.example.com. */
	host: string;
	/** Public base URL the apps use (no trailing slash). Defaults to https://<host>. */
	baseUrl?: string;
	/** Cloudflare Access team domain, e.g. your-team.cloudflareaccess.com. */
	accessTeamDomain: string;
	/** AUD tag of the Access application that protects /admin and /api/admin. */
	accessAud: string;
	/** ntfy server used only to wake the iOS app (poll_request). "" disables. */
	upstreamBaseUrl?: string;
	/** How long messages stay cached for polling, in seconds (ntfy default: 12h). */
	cacheDurationSeconds?: string;
};

const FILE = new URL("./lemmeknow.config.json", import.meta.url);
const file: Partial<LemmeknowConfig> = existsSync(FILE) ? JSON.parse(readFileSync(FILE, "utf8")) : {};
const env = (k: string) => process.env[k] ?? undefined;
const host = env("LEMMEKNOW_HOST") ?? file.host ?? "ntfy.example.com";
const cfg: LemmeknowConfig = {
	accountId: env("LEMMEKNOW_ACCOUNT_ID") ?? file.accountId ?? "",
	host,
	baseUrl: env("LEMMEKNOW_BASE_URL") ?? file.baseUrl ?? `https://${host}`,
	accessTeamDomain: env("LEMMEKNOW_ACCESS_TEAM_DOMAIN") ?? file.accessTeamDomain ?? "your-team.cloudflareaccess.com",
	accessAud: env("LEMMEKNOW_ACCESS_AUD") ?? file.accessAud ?? "",
	upstreamBaseUrl: env("LEMMEKNOW_UPSTREAM_BASE_URL") ?? file.upstreamBaseUrl ?? "https://ntfy.sh",
	cacheDurationSeconds: env("LEMMEKNOW_CACHE_DURATION_SECONDS") ?? file.cacheDurationSeconds ?? "43200",
};
if (!existsSync(FILE) && !env("LEMMEKNOW_ACCOUNT_ID")) {
	console.warn("[lemmeknow] No lemmeknow.config.json found; using example.com placeholders (fine for `cf dev`, not for deploy).");
}

export default defineConfig({
	...(cfg.accountId ? { accountId: cfg.accountId } : {}),
	worker: {
		name: "lemmeknow",
		compatibilityDate: "2026-10-23",
		compatibilityFlags: ["nodejs_compat"],
		entrypoint,
		observability: { enabled: true },
		assets: {
			notFoundHandling: "single-page-application",
			// Everything is ntfy API except the dashboard's static bundle.
			runWorkerFirst: ["/*", "!/assets/*", "!/favicon.svg"],
		},
		domains: [cfg.host],
		workersDev: false,
		previewUrls: false,
		// Delivers scheduled (delayed) messages and prunes expired ones.
		triggers: [triggers.scheduled({ schedule: "* * * * *" })],
		env: {
			DB: bindings.d1({ name: "lemmeknow-db" }),
			HUB: bindings.durableObject({ worker: "lemmeknow", exportName: "Hub" }),
			ASSETS: bindings.assets(),
			BASE_URL: bindings.text(cfg.baseUrl ?? ""),
			ACCESS_TEAM_DOMAIN: bindings.text(cfg.accessTeamDomain),
			// AUD tag of the dashboard's Access application (not a secret).
			ACCESS_AUD: bindings.text(cfg.accessAud),
			UPSTREAM_BASE_URL: bindings.text(cfg.upstreamBaseUrl ?? ""),
			CACHE_DURATION_SECONDS: bindings.text(cfg.cacheDurationSeconds ?? "43200"),
			// UPSTREAM_ACCESS_TOKEN is an optional Worker secret (ntfy.sh token for higher upstream limits).
		},
		exports: {
			Hub: exports.durableObject({ storage: "sqlite" }),
		},
	},
});
