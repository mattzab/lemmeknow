import { Hono } from "hono";
import { authenticate } from "./access";
import { admin } from "./admin";
import type { Env } from "./env";
import { handleNtfy } from "./ntfy-api";
import { runScheduled } from "./service";
import { ensureSchema } from "./store";

export { Hub } from "./hub";

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
	await ensureSchema(c.env.DB);
	await next();
});

app.get("/healthz", (c) => c.json({ ok: true, at: Date.now() }));

// Dashboard API: Cloudflare Access in front, JWT verified again inside (admin.ts).
app.route("/api/admin", admin);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// Dashboard SPA under /admin. The HTML is only served to a verified Access identity.
const spa = async (c: { req: { raw: Request }; env: Env }) => {
	if (!(await authenticate(c.req.raw, c.env))) {
		return new Response("Cloudflare Access authentication required for the Lemmeknow dashboard.\n", { status: 401, headers: { "content-type": "text/plain" } });
	}
	const res = await c.env.ASSETS.fetch(new Request(new URL("/", c.req.raw.url), { headers: c.req.raw.headers }));
	const out = new Response(res.body, res);
	out.headers.set("x-frame-options", "DENY");
	out.headers.set("x-content-type-options", "nosniff");
	out.headers.set("referrer-policy", "strict-origin-when-cross-origin");
	out.headers.set("cache-control", "no-store");
	return out;
};
app.get("/admin", spa);
app.get("/admin/*", spa);
app.get("/", (c) => c.redirect("/admin", 302));

// Everything else is the ntfy protocol (publish, subscribe, poll, health, config).
app.all("*", async (c) => {
	const res = await handleNtfy(c.req.raw, c.env, c.executionCtx);
	if (res) return res;
	return c.json({ code: 40401, http: 404, error: "page not found" }, 404, { "access-control-allow-origin": "*" });
});

export default {
	fetch: app.fetch,
	async scheduled(_event, env, ctx) {
		await ensureSchema(env.DB);
		const r = await runScheduled(env, (p) => ctx.waitUntil(p));
		if (r.delivered || r.pruned) console.log(`cron: delivered ${r.delivered} scheduled, pruned ${r.pruned} expired`);
	},
} satisfies ExportedHandler<Env>;
