# AGENTS.md

This repository is the Cloudflare Worker for `cadbabel.com`: a static landing
page served from the `ASSETS` binding plus a small JSON API backed by D1. It is
a static-assets Worker, never Cloudflare Pages. `src/index.ts` is the only
entrypoint; it routes `/api/*` to `handleApi` in `src/api/router.ts` and passes
everything else to `env.ASSETS.fetch(request)`. Do not add page-specific
redirects, a second entrypoint, or a framework.

## Response contract

The Worker must preserve these observable results:

- `POST /api/event`: HTTP 204 with an empty body for a well-formed
  `{ kind: "page_view" | "door_select", direction: "sw-to-fusion" | "fusion-to-sw" | null }`
  body; HTTP 400 for a malformed body
- `POST /api/reserve`: HTTP 200 with `{ reservation_id, client_secret, publishable_key }`
  after creating a Stripe Customer and SetupIntent; HTTP 400 for a malformed or
  unacknowledged-disclosure body. No charge is ever created
- `POST /api/reserve/confirm`: HTTP 200 with `{ ok: true }`; HTTP 400 for a
  malformed body; HTTP 404 for an unknown `reservation_id`
- `GET /api/stats`: HTTP 200 with per-direction counts when
  `Authorization: Bearer <STATS_TOKEN>` matches; HTTP 401 otherwise
- any other method on an `/api/*` path: HTTP 405 with an empty body
- any unknown `/api/*` path: HTTP 404 with an empty body
- every non-`/api/` path: whatever the assets binding returns, including the
  `404-page` handler

Non-`/api/` paths must never be answered by Worker code. Update the tests in
`test/` whenever this contract changes; tests must assert both status and body.

## Cloudflare boundaries

The deployable environments are:

- production: account `cadbabel-com-prod` (`account_id` in
  `wrangler.production.jsonc`), Worker `cadbabel`, D1 `cadbabel-prod`, custom
  domains `cadbabel.com` and `www.cadbabel.com`, `workers_dev` disabled
- PPE: account `ppe-cadbabel-com` (`account_id` in `wrangler.ppe.jsonc`), Worker
  `cadbabel-ppe`, D1 `cadbabel-ppe`, workers.dev only, no routes

Each Wrangler file pins the `account_id` it is allowed to deploy to, so
`wrangler.production.jsonc` can only ever reach the production account and
`wrangler.ppe.jsonc` can only ever reach PPE. Keep production and PPE in
separate Wrangler files and separate GitHub workflows; never introduce Wrangler
environments, a shared config with overrides, or a fallback account. Production
uses the `cloudflare-production` GitHub environment and PPE uses
`cloudflare-ppe`. Each environment supplies `CLOUDFLARE_ACCOUNT_ID` as a
variable and `CLOUDFLARE_API_TOKEN` as a secret, and each deploy workflow has a
"Verify target account" step that fails when the variable does not equal the
expected account ID literal.

`STRIPE_SECRET_KEY` and `STATS_TOKEN` are Worker secrets and must never appear
in a config file, a test fixture, or `public/`. `STRIPE_PUBLISHABLE_KEY` is
public and belongs in the `vars` block of both Wrangler files.

Account IDs and D1 database IDs that are not yet provisioned are written as the
literals `f2161e1aa7fc40353948a79e3eec5837`, `4e8ec9b758de0cf1e392f7e2d916e96f`,
`e2bb615d-eb91-431e-b906-f6c204719c95`, and `ba42e75c-fed4-4a8b-af30-26c31d70e3f3`. Replace them with real IDs; never
invent one, and never leave a real ID in the wrong file.

## Working commands

Use Node.js 22 or newer.

```sh
npm ci
npm test
npm run typecheck
npm run dev
npm run db:migrate:local
```

Tests run in the Workers pool (`@cloudflare/vitest-pool-workers`) against
`wrangler.ppe.jsonc`, so `test/` sees the real bindings with a local D1.

Do not deploy during routine development or review. Deployment is an explicit
GitHub Actions operation: a push to `main` triggers production, and PPE uses the
manual `Deploy PPE` workflow. Remote migrations (`db:migrate:production`,
`db:migrate:ppe`) are deliberate, separate operations.

## Change discipline

- `interface Env` is declared exactly once, in `src/env.d.ts`. Add a binding
  there and to both Wrangler files in the same change; never redeclare or widen
  it locally, and keep exported signatures free of `any`.
- Serve static files through the assets binding. Files under `public/` are the
  only place for page markup, styles, and scripts.
- Schema changes are new numbered files in `migrations/`; never edit an applied
  migration and never mutate the schema from request handlers.
- Keep client-side behaviour to the two documented `POST /api/event` calls. No
  analytics vendor, no cookies, no third-party script beyond Stripe.js on the
  reservation flow.
- This is a greenfield repository: no compatibility shims, no deprecated
  aliases, no dead code paths. Migrate every caller in the same change.
- Never commit Cloudflare or Stripe credentials, `.dev.vars`, local Wrangler
  state, or `node_modules`.
- Update the README when the API surface, environments, required secrets, or
  deployment triggers change.
