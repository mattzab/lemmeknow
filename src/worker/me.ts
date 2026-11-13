import { Hono } from "hono";
import type { Env } from "./env";
import { createPairCode, ensurePersonalToken, meInfo, type Person, personFromRequest, replaceToken } from "./people";

/**
 * /api/me: the signed-in person's own view, for the web app. Behind Cloudflare Access (like
 * /admin), JWT verified again here. Open to every invited person, not just admins.
 */
type Vars = { person: Person };
export const me = new Hono<{ Bindings: Env; Variables: Vars }>();

me.use("*", async (c, next) => {
	const { person, email } = await personFromRequest(c.req.raw, c.env);
	if (!email) return c.json({ error: "Sign in with Cloudflare Access first." }, 401);
	if (!person) return c.json({ error: `${email} has not been invited to this Lemmeknow. Ask an admin to add you.` }, 403);
	c.set("person", person);
	await next();
	c.header("cache-control", "no-store");
});

me.get("/", async (c) => c.json(await meInfo(c.env, c.get("person"))));

/** New value for the personal token. Devices subscribed with the old one keep receiving pushes. */
me.post("/token/rotate", async (c) => {
	const p = c.get("person");
	const cur = await ensurePersonalToken(c.env, p);
	await replaceToken(c.env, cur.id);
	return c.json(await meInfo(c.env, p));
});

/** A one-time code to sign the Home Screen app in when the login happened in Safari. */
me.post("/pair", async (c) => c.json(await createPairCode(c.env, c.get("person").email)));

me.all("*", (c) => c.json({ error: "Not found" }, 404));
