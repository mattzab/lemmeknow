import { Hono } from "hono";
import { authenticate } from "./access";
import { admin } from "./admin";
import { api } from "./api";
import { type Env, VERSION } from "./env";
import { runScheduled } from "./service";
import { ensureSchema } from "./store";

/**
 * Routing (see cloudflare.config.ts → assets.runWorkerFirst):
 *   /api/v1/*      public Lemmeknow API (token auth)            → api.ts
 *   /api/admin/*   dashboard API (Cloudflare Access JWT)        → admin.ts
 *   /admin, /admin/*  dashboard HTML, only for a verified Access identity
 *   /healthz       liveness probe
 * Everything else (/, /sw.js, /manifest.webmanifest, icons, /assets/*) is the public PWA,
 * served straight from static assets without running the Worker.
 */
const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
	await ensureSchema(c.env.DB);
	await next();
});

app.get("/healthz", (c) => c.json({ ok: true, version: VERSION, at: Date.now() }));

app.route("/api/v1", api);
app.route("/api/admin", admin);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

const dashboard = async (c: { req: { raw: Request }; env: Env }) => {
	if (!(await authenticate(c.req.raw, c.env))) {
		return new Response("Cloudflare Access authentication required for the Lemmeknow dashboard.\n", { status: 401, headers: { "content-type": "text/plain" } });
	}
	// `/admin` resolves to admin.html in the asset bundle (html_handling: auto-trailing-slash).
	const res = await c.env.ASSETS.fetch(new Request(new URL("/admin", c.req.raw.url), { headers: c.req.raw.headers }));
	const out = new Response(res.body, res);
	out.headers.set("x-frame-options", "DENY");
	out.headers.set("x-content-type-options", "nosniff");
	out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
	out.headers.set("cache-control", "no-store");
	return out;
};
app.get("/admin", dashboard);
app.get("/admin/*", dashboard);
app.get("/admin.html", (c) => c.redirect("/admin", 302));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
	fetch: app.fetch,
	async scheduled(_event, env) {
		await ensureSchema(env.DB);
		const r = await runScheduled(env);
		if (r.pruned) console.log(JSON.stringify({ event: "cron_prune", pruned: r.pruned }));
	},
} satisfies ExportedHandler<Env>;
