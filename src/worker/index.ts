import { Hono } from "hono";
import { admin } from "./admin";
import { api } from "./api";
import { type Env, VERSION } from "./env";
import { me } from "./me";
import { evalKeys, evaluateAccess, personFromRequest } from "./people";
import { runScheduled } from "./service";
import { ensureSchema } from "./store";

/**
 * Routing (see cloudflare.config.ts → assets.runWorkerFirst):
 *   /api/v1/*      public Lemmeknow API (token auth)            → api.ts
 *   /api/admin/*   dashboard API (Cloudflare Access JWT)        → admin.ts
 *   /api/me/*      the signed-in person's own token and topics (Access JWT) → me.ts
 *   /admin, /admin/*  dashboard HTML, only for a verified Access identity with the admin role
 *   /login         behind Access: starts the e-mail login, then sends people back to /
 *   /access/evaluate, /access/keys   public: Cloudflare Access External Evaluation (who is invited)
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
app.route("/api/me", me);
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

/** Small self-contained page in the app's zinc/purple look, for login outcomes. */
function page(status: number, title: string, text: string, extra = ""): Response {
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · Lemmeknow</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#e4e4e7;font:15px/1.5 system-ui,sans-serif}main{max-width:26rem;padding:2rem}h1{font-size:1.25rem;color:#fafafa}a{color:#c4b5fd}.b{display:inline-block;margin-top:1rem;padding:.5rem 1rem;border-radius:.5rem;background:#7c3aed;color:#fff;text-decoration:none}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${extra}<a class="b" href="/">Back to Lemmeknow</a></main></body></html>`;
	return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
}

const notInvited = (email: string) =>
	page(403, "Not invited yet", `You signed in as ${email}, but nobody has added that address to this Lemmeknow. Ask an admin to add you, then try again.`, `<p><a href="/cdn-cgi/access/logout">Sign out</a></p>`);

/** /login sits behind Access; by the time we run, the person has proved their e-mail. */
app.get("/login", async (c) => {
	const { person, email } = await personFromRequest(c.req.raw, c.env);
	if (!email) return page(401, "Sign-in did not finish", "Cloudflare Access did not vouch for this request. Try again from the Log in button.");
	if (!person) return notInvited(email);
	return c.redirect("/?signed_in=1", 302);
});

// Cloudflare Access External Evaluation. Public: Access calls these, the answer is signed by us.
app.get("/access/keys", async (c) => {
	c.header("cache-control", "public, max-age=300");
	return c.json(await evalKeys(c.env));
});
app.post("/access/evaluate", async (c) => {
	try {
		const r = await evaluateAccess(c.env, await c.req.json());
		console.log(JSON.stringify({ event: "access_evaluate", success: r.success }));
		return c.json({ token: r.token });
	} catch (e) {
		console.warn(JSON.stringify({ event: "access_evaluate_rejected", error: (e as Error).message }));
		return c.json({ error: "invalid evaluation request" }, 400);
	}
});

const dashboard = async (c: { req: { raw: Request }; env: Env }) => {
	const { person, email } = await personFromRequest(c.req.raw, c.env);
	if (!email) {
		return new Response("Cloudflare Access authentication required for the Lemmeknow dashboard.\n", { status: 401, headers: { "content-type": "text/plain" } });
	}
	if (!person) return notInvited(email);
	if (person.role !== "admin") return page(403, "Admins only", `You are signed in as ${email}. The dashboard is for admins; your topics and token are in the app.`);
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
