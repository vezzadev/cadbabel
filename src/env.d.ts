// Bindings for the cadbabel Worker. Declared once, here; never redeclared in
// src/api/** or test/**. Keep in sync with wrangler.production.jsonc and
// wrangler.ppe.jsonc.
//
// Worker secrets are optional on purpose: an unset secret is absent from `env`
// entirely, so typing one as `string` lets the compiler bless
// `env.SECRET.length` — which is the 500-on-an-already-written-row this API
// shipped once already. Optional forces a falsy guard at every use site.
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  ENVIRONMENT: "production" | "ppe" | "dev";
  STRIPE_PUBLISHABLE_KEY?: string; // wrangler config var (public)
  STRIPE_SECRET_KEY?: string; // Worker secret
  STRIPE_WEBHOOK_SECRET?: string; // Worker secret, verifies POST /api/stripe/webhook
  STATS_TOKEN?: string; // Worker secret, guards GET /api/stats
  EVENT_RATE_LIMIT: RateLimit;
  RESERVE_RATE_LIMIT: RateLimit;
}

// Tests in the Workers pool see the same bindings.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
