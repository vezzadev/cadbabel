# cadbabel.com

CAD Babel is a translation bureau for parametric CAD feature history: a part
modelled in SolidWorks is rebuilt as an editable Fusion feature tree, and the
reverse. This repository is the site and the reservation backend behind
`cadbabel.com` — a static landing page plus four JSON endpoints that record
which translation direction visitors ask for and take reservations. A
reservation stores a payment method with Stripe (Customer + SetupIntent) and
never charges it; the demand signal, not the money, is the point. There is no
analytics vendor, no cookies, and no client-side tracking beyond two explicit
`POST /api/event` calls from the page.

Everything runs as a single Cloudflare Worker with static assets: `src/index.ts`
routes `/api/*` to `src/api/router.ts` and serves every other path from the
`ASSETS` binding over `public/`. State lives in Cloudflare D1.

## API surface

| Method | Path | Request | Response |
| --- | --- | --- | --- |
| POST | `/api/event` | `{ kind: "page_view" \| "door_select", direction: "sw-to-fusion" \| "fusion-to-sw" \| null }` | `204`, empty body |
| POST | `/api/reserve` | `{ email, direction, purpose, needed_by, disclosure_ack, disclosure_shown_at }` | `{ reservation_id, client_secret, publishable_key }` |
| POST | `/api/reserve/confirm` | `{ reservation_id, setup_intent_id }` | `{ ok: true }` |
| GET | `/api/stats` | header `Authorization: Bearer <STATS_TOKEN>` | per-direction counts |

`POST /api/reserve` creates the Stripe Customer and SetupIntent; no charge is
made at any point in the flow.

## Local development

Use Node.js 22 or newer.

```sh
npm ci
npm run dev              # wrangler dev against wrangler.ppe.jsonc
npm run db:migrate:local # apply migrations/ to the local D1 database
npm test
npm run typecheck
```

`npm run dev` reads secrets from an untracked `.dev.vars`:

```ini
STRIPE_SECRET_KEY=sk_test_...
STATS_TOKEN=any-local-value
```

`STRIPE_PUBLISHABLE_KEY` is a public value and lives in the `vars` block of the
Wrangler config files, not in `.dev.vars`.

## Cloudflare environments

| Environment | Cloudflare account | Worker | Wrangler config | D1 database |
| --- | --- | --- | --- | --- |
| production | `cadbabel-com-prod` | `cadbabel` | `wrangler.production.jsonc` | `cadbabel-prod` |
| PPE | `ppe-cadbabel-com` | `cadbabel-ppe` | `wrangler.ppe.jsonc` | `cadbabel-ppe` |

Production serves `cadbabel.com` and `www.cadbabel.com` as custom domains and
has `workers_dev` disabled. PPE is workers.dev-only and declares no routes.

Each config pins its `account_id`, so a config can only ever deploy to its own
account. The account IDs and D1 database IDs are placeholders
(`f2161e1aa7fc40353948a79e3eec5837`, `4e8ec9b758de0cf1e392f7e2d916e96f`, `e2bb615d-eb91-431e-b906-f6c204719c95`,
`ba42e75c-fed4-4a8b-af30-26c31d70e3f3`) until the accounts and databases are provisioned.

### Required configuration

| Name | Kind | Where |
| --- | --- | --- |
| `STRIPE_SECRET_KEY` | Worker secret | `wrangler secret put --config <config>` |
| `STATS_TOKEN` | Worker secret | `wrangler secret put --config <config>` |
| `STRIPE_PUBLISHABLE_KEY` | public var | `vars` in each Wrangler config |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub environment variable | `cloudflare-production`, `cloudflare-ppe` |
| `CLOUDFLARE_API_TOKEN` | GitHub environment secret | `cloudflare-production`, `cloudflare-ppe` |

## Deployment

Deployment is a GitHub Actions operation, not a local one.

- `Verify` runs on every pull request and on pushes to `main`: `npm ci`,
  `npm run typecheck`, `npm test`.
- `Deploy production` runs on pushes to `main` and on manual dispatch. It uses
  the `cloudflare-production` environment and refuses to continue unless
  `vars.CLOUDFLARE_ACCOUNT_ID` matches the production account ID.
- `Deploy PPE` is manual dispatch only, uses the `cloudflare-ppe` environment,
  and asserts the PPE account ID the same way.

Database migrations are applied separately from a checkout with Cloudflare
credentials in the environment:

```sh
npm run db:migrate:ppe
npm run db:migrate:production
```

## License

MIT. See [LICENSE](LICENSE).
