// Bindings for the cadbabel Worker. Declared once, here; never redeclared in
// src/api/** or test/**. Keep in sync with wrangler.production.jsonc and
// wrangler.ppe.jsonc.
interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  STRIPE_SECRET_KEY: string; // Worker secret
  STRIPE_PUBLISHABLE_KEY: string; // wrangler config var (public)
  STATS_TOKEN: string; // Worker secret, guards GET /api/stats
}

// Tests in the Workers pool see the same bindings.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
