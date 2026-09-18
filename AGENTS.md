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
  body; HTTP 400 for a malformed body; HTTP 415 for a non-JSON content type;
  HTTP 413 when `content-length` exceeds 4096
- `POST /api/reserve`: HTTP **201** with
  `{ reservation_id, card_step, client_secret, publishable_key }`. `card_step`
  is `"stripe"` once a Customer and SetupIntent exist, or `"unconfigured"` with
  both secrets null when `STRIPE_SECRET_KEY` or `STRIPE_PUBLISHABLE_KEY` is
  absent — the door can be live before Stripe is. HTTP 400 for a malformed
  body, an unacknowledged disclosure, or a `disclosure_shown_at` that is not an
  ISO-8601 instant inside `[now - 24h, now + 5min]`; HTTP 409 when the email
  already holds a SetupIntent; HTTP 502 for a Stripe outage and HTTP 500 for our
  own Stripe misconfiguration. No charge is ever created
- `POST /api/reserve/confirm`: HTTP 200 with `{ ok: true }`; HTTP 400 for a
  malformed body; HTTP 404 for an unknown `reservation_id`; HTTP 409 when the
  reservation has no SetupIntent, the submitted id is not the stored one, or the
  intent has not succeeded
- `POST /api/stripe/webhook`: HTTP 200 with `{ received: true }` for any
  delivery whose `stripe-signature` verifies, whether or not it flips a row;
  HTTP 400 for a missing, malformed, stale, or unverifiable signature; HTTP 500
  when `STRIPE_WEBHOOK_SECRET` is unset. The body is read as raw text because
  the signature covers the exact bytes, so the 4096-byte cap does not apply
- `GET /api/stats`: HTTP 200 with `{ totals, directions }` when
  `Authorization: Bearer <STATS_TOKEN>` matches — the scheme is matched
  case-insensitively per RFC 7235 §2.1, the token byte for byte. Optional
  `?since=` and `?until=` take ISO-8601 instants and bound **both** aggregates
  inclusively on `created_at`; a malformed bound is HTTP 400, never a silently
  unwindowed answer. HTTP 401 without a matching token
- `POST /api/event`, `/api/reserve`, and `/api/reserve/confirm`: HTTP 429 with
  `{ error }` and a `retry-after` header once the per-IP limiter refuses.
  `/api/stripe/webhook` is never throttled; it is signature-verified, and a
  dropped delivery is a lost `card_on_file`
- any other method on an `/api/*` path: HTTP 405 with `{ "error": "method not
  allowed" }` and an `allow` header
- any unknown `/api/*` path: HTTP 404 with `{ "error": "not found" }`
- every non-`/api/` path: whatever the assets binding returns, including the
  `404-page` handler

Every error body on an `/api/*` path is a JSON object with a single `error`
string; field names may appear in it, submitted values never do. Every
timestamp the Worker stores is an ISO-8601 UTC instant with a `T` and a `Z`
written explicitly by the Worker, so `created_at` comparisons — including the
`?since=`/`?until=` window — are lexicographic.

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

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `STATS_TOKEN` are Worker
secrets and must never appear in a config file, a test fixture, or `public/`.
`STRIPE_PUBLISHABLE_KEY` and `ENVIRONMENT` are public and belong in the `vars`
block of both Wrangler files. Both Stripe keys are test-mode keys in both
environments, deliberately: the bureau is not operating, nothing is ever
charged, and test mode makes that visible on the page.

The account and database IDs in the Wrangler files are real and live, not
placeholders:

| Value | production | PPE |
| --- | --- | --- |
| `account_id` | `f2161e1aa7fc40353948a79e3eec5837` | `4e8ec9b758de0cf1e392f7e2d916e96f` |
| `database_id` | `e2bb615d-eb91-431e-b906-f6c204719c95` | `ba42e75c-fed4-4a8b-af30-26c31d70e3f3` |

`cadbabel.com` and `www.cadbabel.com` are serving from the production Worker
today. Both D1 databases exist and are migrated. Never move an ID between
files, and never invent one: the production `account_id` is asserted a second
time as a literal in `deploy-production.yml`, and PPE's in `deploy-ppe.yml`, so
a swapped ID fails the workflow rather than deploying to the wrong account.

`EVENT_RATE_LIMIT` (20 requests/60s) and `RESERVE_RATE_LIMIT` (3 requests/60s)
are declared in the `ratelimits` block of both Wrangler files and applied in
`src/api/router.ts`, keyed on `CF-Connecting-IP`. The platform binding accepts
only a 10- or 60-second period, so a longer window is not expressible here.
Confirm a change with `wrangler deploy --dry-run`, which prints each limiter
under "Your Worker has access to the following bindings": the Wrangler pinned
inside `@cloudflare/vitest-pool-workers` predates the `ratelimits` field and
ignores it, so the bindings are absent under `npm test` and the router's
"binding missing" path is what the suite exercises.

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
`test/api.test.ts` drives the handlers directly; `test/platform.test.ts` drives
the deployed shape through `SELF.fetch` — the entrypoint's `/api/` split, the
asset fallthrough, the limiters, the body cap, and the stats window.

Do not deploy during routine development or review. Deployment is an explicit
GitHub Actions operation: a push to `main` triggers production, and PPE uses the
manual `Deploy PPE` workflow. Each deploy workflow runs `npm run typecheck` and
`npm test`, asserts its account ID, then applies that environment's D1
migrations, and only then deploys the Worker — a Worker deployed against an
unmigrated database answers every endpoint with a 500, so the order is part of
the workflow rather than a checklist. `db:migrate:production` and
`db:migrate:ppe` remain runnable by hand for a migration that must land outside
a deploy.

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
