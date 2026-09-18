import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    include: ["test/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        wrangler: { configPath: "./wrangler.ppe.jsonc" },
        // STATS_TOKEN is a Worker secret, so it reaches `wrangler dev` through
        // .dev.vars and CI has no such file: without this binding the stats
        // suite silently asserted against an unset token and every request
        // fail-closed with 401. Declared here so the suite is identical on a
        // developer box and in Actions. The Stripe secrets stay undeclared on
        // purpose — the absent-binding rows assert what happens without them.
        miniflare: { bindings: { STATS_TOKEN: "vitest-stats-token" } },
      },
    },
  },
});
