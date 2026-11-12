import type { NtfyMessage } from "../src/shared/types";
import type { Env } from "../src/worker/env";
import { resetSchemaFlag, ensureSchema } from "../src/worker/store";
import { fakeD1 } from "./fake-d1";

/** A fake Env with an in-memory D1 and a hub stub that records broadcasts. */
export async function fakeEnv(overrides: Partial<Env> = {}) {
	const { db, sql } = fakeD1();
	const broadcasts: NtfyMessage[] = [];
	const hubStub = {
		broadcast: async (m: NtfyMessage) => {
			broadcasts.push(m);
			return 1;
		},
		subscriberCounts: async () => ({}),
		fetch: async () => new Response("no websockets in unit tests", { status: 501 }),
	};
	const env = {
		DB: db as unknown as D1Database,
		HUB: { idFromName: (n: string) => n, get: () => hubStub } as unknown as Env["HUB"],
		ASSETS: { fetch: async () => new Response("<html></html>") } as unknown as Fetcher,
		BASE_URL: "https://ntfy.example.com",
		ACCESS_TEAM_DOMAIN: "",
		ACCESS_AUD: "",
		UPSTREAM_BASE_URL: "https://upstream.example.net",
		CACHE_DURATION_SECONDS: "43200",
		...overrides,
	} satisfies Env;
	resetSchemaFlag();
	await ensureSchema(env.DB);
	const waits: Promise<unknown>[] = [];
	const ctx = { waitUntil: (p: Promise<unknown>) => void waits.push(p) };
	return { env, sql, broadcasts, ctx, waits };
}

export const req = (path: string, init: RequestInit = {}) => new Request(`https://ntfy.example.com${path}`, init);

export async function lines(res: Response): Promise<Record<string, unknown>[]> {
	const t = await res.text();
	return t
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
}
