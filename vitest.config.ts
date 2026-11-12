import { defineConfig } from "vitest/config";
export default defineConfig({
	test: { include: ["test/**/*.test.ts"] },
	resolve: {
		alias: {
			"cloudflare:workers": new URL("./test/stub-workers.ts", import.meta.url).pathname,
			"@shared": new URL("./src/shared", import.meta.url).pathname,
		},
	},
});
