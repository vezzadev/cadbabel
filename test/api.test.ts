import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import initSchema from "../migrations/0001_init.sql?raw";
import isoTimestampSchema from "../migrations/0002_iso_timestamps.sql?raw";
import { handleApi } from "../src/api/router";
import { handleStripeWebhook } from "../src/api/webhook";

const STATS_TOKEN = "stats-token-for-tests";
const STRIPE_SECRET_KEY = "sk_test_cadbabel";
const STRIPE_PUBLISHABLE_KEY = "pk_test_cadbabel";
const STRIPE_WEBHOOK_SECRET = "whsec_test_cadbabel";
// `requiredTimestamp` only accepts an instant inside a window around now, so
// the disclosure fixture is generated rather than hard-coded. One value per
// run, so a row can be asserted against it.
const DISCLOSURE_SHOWN_AT = new Date(Date.now() - 60_000).toISOString();
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The real migrations, replayed statement by statement (D1 has no multi-statement prepare). */
const SCHEMA_STATEMENTS = [initSchema, isoTimestampSchema].flatMap((file) =>
  file
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0),
);

/** Rate limiting belongs to the router and has its own tests; never throttle these. */
const UNLIMITED: RateLimit = { limit: async () => ({ success: true }) };

function apiEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...env,
    ENVIRONMENT: "ppe",
    STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY,
    STRIPE_WEBHOOK_SECRET,
    STATS_TOKEN,
    EVENT_RATE_LIMIT: UNLIMITED,
    RESERVE_RATE_LIMIT: UNLIMITED,
    ...overrides,
  };
}

async function call(request: Request, environment: Env = apiEnv()): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleApi(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function jsonRequest(path: string, body: unknown, method = "POST"): Request {
  return new Request(`https://cadbabel.com${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function countRows(table: "events" | "reservations"): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>();
  return row?.n ?? -1;
}

interface StripeStub {
  method: "GET" | "POST";
  path: string;
  status?: number;
  body: unknown;
  headers?: Record<string, string | RegExp>;
}

/** Any Stripe call without a matching stub throws: net connect is disabled. */
function stubStripe(...stubs: StripeStub[]): void {
  const pool = fetchMock.get("https://api.stripe.com");
  for (const stub of stubs) {
    pool
      .intercept({ method: stub.method, path: stub.path, ...(stub.headers ? { headers: stub.headers } : {}) })
      .reply(stub.status ?? 200, stub.body as Record<string, unknown>);
  }
}

function setupIntentPayload(id: string, status: string): Record<string, unknown> {
  return { id, status, client_secret: `${id}_secret_live`, customer: "cus_test" };
}

function reservePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "buyer@example.com",
    direction: "sw-to-fusion",
    purpose: "client-deliverable",
    needed_by: "2026-10-15",
    disclosure_ack: true,
    disclosure_shown_at: DISCLOSURE_SHOWN_AT,
    ...overrides,
  };
}

/** Drives the real POST /api/reserve so confirm tests exercise a genuine row. */
async function reserveSuccessfully(
  setupIntentId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  stubStripe(
    { method: "POST", path: "/v1/customers", body: { id: "cus_test" } },
    {
      method: "POST",
      path: "/v1/setup_intents",
      body: setupIntentPayload(setupIntentId, "requires_payment_method"),
    },
  );
  const response = await call(jsonRequest("/api/reserve", reservePayload(overrides)));
  expect(response.status).toBe(201);
  const body = await bodyOf(response);
  return body["reservation_id"] as string;
}

async function cardOnFile(reservationId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT card_on_file FROM reservations WHERE id = ?")
    .bind(reservationId)
    .first<{ card_on_file: number }>();
  return row?.card_on_file ?? -1;
}

async function reservationRow(reservationId: string): Promise<Record<string, unknown> | null> {
  return env.DB.prepare("SELECT * FROM reservations WHERE id = ?")
    .bind(reservationId)
    .first<Record<string, unknown>>();
}

async function reservationIdFor(email: string): Promise<string> {
  const row = await env.DB.prepare("SELECT id FROM reservations WHERE email = ?")
    .bind(email)
    .first<{ id: string }>();
  return row?.id ?? "";
}

/**
 * Records outbound requests, so a test can prove a route made no Stripe call at
 * all, or inspect the form body it sent.
 */
function recordFetches(): { urls: string[]; bodies: string[]; restore: () => void } {
  const urls: string[] = [];
  const bodies: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    urls.push(input instanceof Request ? input.url : String(input));
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return original(input as RequestInfo, init);
  };
  return {
    urls,
    bodies,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function setupIntentSucceededEvent(reservationId: string, setupIntentId: string): string {
  return JSON.stringify({
    id: "evt_test_webhook",
    type: "setup_intent.succeeded",
    data: {
      object: { id: setupIntentId, object: "setup_intent", metadata: { reservation_id: reservationId } },
    },
  });
}

/** Signs exactly as Stripe does: HMAC-SHA256 over `<t>.<raw body>`. */
async function stripeSignatureHeader(
  raw: string,
  timestampSeconds: number,
  secret: string = STRIPE_WEBHOOK_SECRET,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${timestampSeconds}.${raw}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestampSeconds},v1=${hex}`;
}

/**
 * `extra` exists because workerd does not synthesise `content-length` for a
 * string body — the same thing a chunked upload does not send — so a test that
 * wants the declared length consulted has to say so.
 */
async function postWebhook(
  raw: string,
  signature: string | null,
  extra: Record<string, string> = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (signature !== null) headers["stripe-signature"] = signature;
  return call(
    new Request("https://cadbabel.com/api/stripe/webhook", { method: "POST", headers, body: raw }),
  );
}

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  // Including 0002's scratch tables, in case a previous run died mid-migration.
  for (const table of ["events", "reservations", "events_v2", "reservations_v2"]) {
    await env.DB.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  }
  for (const statement of SCHEMA_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

beforeEach(async () => {
  await env.DB.prepare("DELETE FROM reservations").run();
  await env.DB.prepare("DELETE FROM events").run();
});

afterEach(() => {
  fetchMock.assertNoPendingInterceptors();
});

describe("POST /api/event", () => {
  it("records an undirected page view", async () => {
    const response = await call(jsonRequest("/api/event", { kind: "page_view", direction: null }));

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const row = await env.DB.prepare("SELECT kind, direction FROM events").first<{
      kind: string;
      direction: string | null;
    }>();
    expect(row).toEqual({ kind: "page_view", direction: null });
  });

  it("records a door selection against its direction", async () => {
    const response = await call(
      jsonRequest("/api/event", { kind: "door_select", direction: "fusion-to-sw" }),
    );

    expect(response.status).toBe(204);
    const row = await env.DB.prepare("SELECT kind, direction FROM events").first<{
      kind: string;
      direction: string | null;
    }>();
    expect(row).toEqual({ kind: "door_select", direction: "fusion-to-sw" });
  });

  it("rejects door_select with a null direction and writes nothing", async () => {
    const response = await call(jsonRequest("/api/event", { kind: "door_select", direction: null }));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: "direction: expected one of sw-to-fusion, fusion-to-sw",
    });
    expect(await countRows("events")).toBe(0);
  });

  it("rejects page_view carrying a direction and writes nothing", async () => {
    const response = await call(
      jsonRequest("/api/event", { kind: "page_view", direction: "sw-to-fusion" }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "direction: must be null for page_view" });
    expect(await countRows("events")).toBe(0);
  });

  it("rejects an omitted direction key", async () => {
    const response = await call(jsonRequest("/api/event", { kind: "page_view" }));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "direction: required (null for page_view)" });
    expect(await countRows("events")).toBe(0);
  });

  it("rejects unknown fields instead of silently dropping them", async () => {
    const response = await call(
      jsonRequest("/api/event", { kind: "page_view", direction: null, referrer: "https://x.test" }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "referrer: unknown field" });
    expect(await countRows("events")).toBe(0);
  });

  it("rejects a non-JSON content type with 415", async () => {
    const response = await call(
      new Request("https://cadbabel.com/api/event", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{"kind":"page_view","direction":null}',
      }),
    );

    expect(response.status).toBe(415);
    expect(await bodyOf(response)).toEqual({ error: "content-type: expected application/json" });
    expect(await countRows("events")).toBe(0);
  });

  it("rejects a malformed JSON body", async () => {
    const response = await call(
      new Request("https://cadbabel.com/api/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "body: expected valid JSON" });
  });
});

describe("routing", () => {
  it("404s an unknown /api path", async () => {
    const response = await call(new Request("https://cadbabel.com/api/nope"));

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: "not found" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("405s a wrong method and names the allowed one", async () => {
    const response = await call(new Request("https://cadbabel.com/api/event"));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await bodyOf(response)).toEqual({ error: "method not allowed" });
  });

  it("405s a POST to the read-only stats route", async () => {
    const response = await call(jsonRequest("/api/stats", {}));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });

  it("treats a trailing slash as the same route", async () => {
    const response = await call(jsonRequest("/api/event/", { kind: "page_view", direction: null }));

    expect(response.status).toBe(204);
    expect(await countRows("events")).toBe(1);
  });

  it("returns 500 with nothing but {error:internal} when a dependency throws", async () => {
    const brokenDb = {
      prepare() {
        throw new Error("d1 offline: connection to sk_test_cadbabel pool lost");
      },
    } as unknown as D1Database;

    const response = await call(
      jsonRequest("/api/event", { kind: "page_view", direction: null }),
      apiEnv({ DB: brokenDb }),
    );
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).toBe('{"error":"internal"}');
    expect(text).not.toContain("d1 offline");
    expect(text).not.toContain(STRIPE_SECRET_KEY);
  });
});

describe("POST /api/reserve", () => {
  it("creates a Stripe customer and SetupIntent and stores the reservation", async () => {
    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_happy" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_happy", "requires_payment_method"),
      },
    );

    const response = await call(jsonRequest("/api/reserve", reservePayload()));
    const body = await bodyOf(response);

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body["client_secret"]).toBe("seti_happy_secret_live");
    expect(body["card_step"]).toBe("stripe");
    expect(body["publishable_key"]).toBe(STRIPE_PUBLISHABLE_KEY);
    expect(String(body["reservation_id"])).toMatch(UUID);

    const row = await env.DB.prepare("SELECT * FROM reservations WHERE id = ?")
      .bind(body["reservation_id"] as string)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      email: "buyer@example.com",
      direction: "sw-to-fusion",
      purpose: "client-deliverable",
      needed_by: "2026-10-15",
      disclosure_shown_at: DISCLOSURE_SHOWN_AT,
      disclosure_ack: 1,
      stripe_customer_id: "cus_happy",
      stripe_setup_intent_id: "seti_happy",
      card_on_file: 0,
    });
    // Same shape as disclosure_shown_at, so the two are comparable and a
    // ?since= window means something.
    expect(String(row?.["created_at"])).toMatch(ISO_INSTANT);
  });

  it.each([
    ["empty strings", { STRIPE_SECRET_KEY: "", STRIPE_PUBLISHABLE_KEY: "" }],
    // An unset Worker secret is missing from `env`, not empty. Production hit
    // exactly this and answered 500 on an already-written row.
    ["absent bindings", { STRIPE_SECRET_KEY: undefined, STRIPE_PUBLISHABLE_KEY: undefined }],
  ])("records the reservation without touching Stripe (%s)", async (label, keys) => {
    stubStripe();
    const email = `keyless-${label.replace(/\W+/g, "-")}@example.com`;

    const response = await call(
      jsonRequest("/api/reserve", reservePayload({ email })),
      apiEnv(keys),
    );
    const body = await bodyOf(response);

    expect(response.status).toBe(201);
    expect(body["card_step"]).toBe("unconfigured");
    expect(body["client_secret"]).toBeNull();
    expect(body["publishable_key"]).toBeNull();

    const row = await env.DB.prepare("SELECT * FROM reservations WHERE id = ?")
      .bind(body["reservation_id"] as string)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      email,
      stripe_customer_id: null,
      stripe_setup_intent_id: null,
      card_on_file: 0,
    });
  });

  it("sends an idempotency key derived from the reservation id on both writes", async () => {
    // Load-bearing twice over: the interceptors only match when the header is
    // present and shaped `<uuid>:customer` / `<uuid>:setup_intent`, and the key
    // is seeded from the reservation row id, so a retry against a recovered row
    // (see "attaches Stripe to a reservation …") reuses it and Stripe replays
    // the original objects instead of minting duplicates.
    stubStripe(
      {
        method: "POST",
        path: "/v1/customers",
        body: { id: "cus_idem" },
        headers: { "idempotency-key": /^[0-9a-f-]{36}:customer$/ },
      },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_idem", "requires_payment_method"),
        headers: { "idempotency-key": /^[0-9a-f-]{36}:setup_intent$/ },
      },
    );

    const response = await call(jsonRequest("/api/reserve", reservePayload()));

    expect(response.status).toBe(201);
  });

  it("rejects disclosure_ack: false without writing a reservation or touching Stripe", async () => {
    const response = await call(
      jsonRequest("/api/reserve", reservePayload({ disclosure_ack: false })),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "disclosure_ack: must be true" });
    expect(await countRows("reservations")).toBe(0);
  });

  it("rejects a missing disclosure_ack", async () => {
    const payload = reservePayload();
    delete payload["disclosure_ack"];

    const response = await call(jsonRequest("/api/reserve", payload));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "disclosure_ack: must be true" });
    expect(await countRows("reservations")).toBe(0);
  });

  it("409s a second reservation for an email that already has a SetupIntent", async () => {
    const reservationId = await reserveSuccessfully("seti_first");

    const response = await call(jsonRequest("/api/reserve", reservePayload()));

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({ error: "email already reserved" });
    expect(await countRows("reservations")).toBe(1);
    // The loser of the race must not disturb the winner's Stripe objects.
    expect(await reservationRow(reservationId)).toMatchObject({
      stripe_customer_id: "cus_test",
      stripe_setup_intent_id: "seti_first",
      card_on_file: 0,
    });
  });

  it("attaches Stripe to a reservation that was taken while Stripe was unconfigured", async () => {
    const unconfigured = await call(
      jsonRequest("/api/reserve", reservePayload()),
      apiEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_PUBLISHABLE_KEY: undefined }),
    );
    const stranded = await bodyOf(unconfigured);
    expect(stranded["card_step"]).toBe("unconfigured");

    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_late" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_late", "requires_payment_method"),
      },
    );

    const recovered = await call(jsonRequest("/api/reserve", reservePayload()));
    const body = await bodyOf(recovered);

    expect(recovered.status).toBe(201);
    expect(body["reservation_id"]).toBe(stranded["reservation_id"]);
    expect(body["card_step"]).toBe("stripe");
    expect(body["client_secret"]).toBe("seti_late_secret_live");
    expect(body["publishable_key"]).toBe(STRIPE_PUBLISHABLE_KEY);
    expect(await countRows("reservations")).toBe(1);
    expect(await reservationRow(stranded["reservation_id"] as string)).toMatchObject({
      stripe_customer_id: "cus_late",
      stripe_setup_intent_id: "seti_late",
      card_on_file: 0,
    });
  });

  it("keeps the filed direction when it recovers a row, in Stripe's metadata and in the response", async () => {
    // The second attempt carries the other direction. Nothing here proves it
    // comes from whoever filed the row, and the row is what the counters read,
    // so the stored direction wins and the caller is told which one it is.
    const unconfigured = await call(
      jsonRequest("/api/reserve", reservePayload({ direction: "sw-to-fusion" })),
      apiEnv({ STRIPE_SECRET_KEY: undefined, STRIPE_PUBLISHABLE_KEY: undefined }),
    );
    const stranded = await bodyOf(unconfigured);
    expect(stranded["direction"]).toBe("sw-to-fusion");
    expect(stranded["reservation_state"]).toBe("created");
    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_kept" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_kept", "requires_payment_method"),
      },
    );
    const recorder = recordFetches();

    const recovered = await call(
      jsonRequest("/api/reserve", reservePayload({ direction: "fusion-to-sw", purpose: "hobby" })),
    );
    recorder.restore();
    const body = await bodyOf(recovered);

    expect(recovered.status).toBe(201);
    expect(body["direction"]).toBe("sw-to-fusion");
    // The page needs the fact, not a diff: a recovered row may hold exactly the
    // answers just submitted, and then "we kept what was filed" is still the
    // only honest message.
    expect(body["reservation_state"]).toBe("recovered");
    expect(body["purpose"]).toBe("client-deliverable");
    const customerForm = new URLSearchParams(recorder.bodies[0]);
    expect(customerForm.get("metadata[direction]")).toBe("sw-to-fusion");
    expect(customerForm.get("metadata[purpose]")).toBe("client-deliverable");
    expect(await reservationRow(stranded["reservation_id"] as string)).toMatchObject({
      direction: "sw-to-fusion",
      purpose: "client-deliverable",
    });
  });

  it("refuses to hand out a client_secret it could not store, and recovers on retry", async () => {
    // The first reservation owns seti_shared. The second is handed the same id
    // by Stripe, which the unique index on stripe_setup_intent_id refuses, so
    // the UPDATE that patches the ids in fails.
    await reserveSuccessfully("seti_shared");
    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_second" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_shared", "requires_payment_method"),
      },
    );

    const blocked = await call(
      jsonRequest("/api/reserve", reservePayload({ email: "second@example.com" })),
    );

    expect(blocked.status).toBe(500);
    expect(await bodyOf(blocked)).toEqual({ error: "internal" });
    const strandedId = await reservationIdFor("second@example.com");
    expect(await reservationRow(strandedId)).toMatchObject({
      stripe_customer_id: null,
      stripe_setup_intent_id: null,
      card_on_file: 0,
    });

    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_second" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_second", "requires_payment_method"),
      },
    );

    const retry = await call(
      jsonRequest("/api/reserve", reservePayload({ email: "second@example.com" })),
    );

    expect(retry.status).toBe(201);
    expect((await bodyOf(retry))["reservation_id"]).toBe(strandedId);
    expect(await reservationRow(strandedId)).toMatchObject({
      stripe_customer_id: "cus_second",
      stripe_setup_intent_id: "seti_second",
    });
  });

  it("tags both Stripe objects with the environment that created them", async () => {
    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_env" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        body: setupIntentPayload("seti_env", "requires_payment_method"),
      },
    );
    const recorder = recordFetches();

    const response = await call(
      jsonRequest("/api/reserve", reservePayload()),
      apiEnv({ ENVIRONMENT: "production" }),
    );
    recorder.restore();

    expect(response.status).toBe(201);
    expect(recorder.bodies).toHaveLength(2);
    for (const form of recorder.bodies) {
      expect(new URLSearchParams(form).get("metadata[environment]")).toBe("production");
    }
  });

  it.each([
    ["a rejected key", 401, "api_error", 500, '{"error":"internal"}'],
    ["a request we built wrong", 400, "invalid_request_error", 500, '{"error":"internal"}'],
    ["a Stripe outage", 503, "api_error", 502, '{"error":"payment provider unavailable"}'],
  ])(
    "does not blame Stripe for %s",
    async (_label, stripeStatus, type, expectedStatus, expectedBody) => {
      stubStripe({
        method: "POST",
        path: "/v1/customers",
        status: stripeStatus,
        body: { error: { type, code: "whatever", message: "detail for the log only" } },
      });

      const response = await call(jsonRequest("/api/reserve", reservePayload()));
      const text = await response.text();

      expect(response.status).toBe(expectedStatus);
      expect(text).toBe(expectedBody);
      expect(text).not.toContain("detail for the log only");
      expect(await countRows("reservations")).toBe(0);
    },
  );

  it("rejects a malformed email without echoing the submitted value", async () => {
    const response = await call(
      jsonRequest("/api/reserve", reservePayload({ email: "<script>@@nope" })),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "email: expected an email address" });
    expect(await countRows("reservations")).toBe(0);
  });

  it("rejects an unsupported purpose", async () => {
    const response = await call(jsonRequest("/api/reserve", reservePayload({ purpose: "resale" })));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: "purpose: expected one of client-deliverable, product, hobby",
    });
  });

  it("502s and leaves no row when Stripe rejects the customer create", async () => {
    stubStripe({
      method: "POST",
      path: "/v1/customers",
      status: 402,
      body: { error: { code: "card_declined", message: "nope" } },
    });

    const response = await call(jsonRequest("/api/reserve", reservePayload()));
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toBe('{"error":"payment provider unavailable"}');
    expect(text).not.toContain(STRIPE_SECRET_KEY);
    expect(await countRows("reservations")).toBe(0);
  });

  it("502s and rolls the row back when the SetupIntent create fails", async () => {
    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_rollback" } },
      {
        method: "POST",
        path: "/v1/setup_intents",
        status: 500,
        body: { error: { code: "api_error", message: "stripe is down" } },
      },
    );

    const response = await call(jsonRequest("/api/reserve", reservePayload()));

    expect(response.status).toBe(502);
    expect(await countRows("reservations")).toBe(0);
  });

  it("502s when Stripe returns a SetupIntent with no client secret", async () => {
    stubStripe(
      { method: "POST", path: "/v1/customers", body: { id: "cus_bad" } },
      { method: "POST", path: "/v1/setup_intents", body: { id: "seti_bad", status: "succeeded" } },
    );

    const response = await call(jsonRequest("/api/reserve", reservePayload()));

    expect(response.status).toBe(502);
    expect(await countRows("reservations")).toBe(0);
  });
});

describe("POST /api/reserve/confirm", () => {
  it("sets card_on_file when Stripe reports the stored intent succeeded", async () => {
    const reservationId = await reserveSuccessfully("seti_confirmed");
    stubStripe({
      method: "GET",
      path: "/v1/setup_intents/seti_confirmed",
      body: setupIntentPayload("seti_confirmed", "succeeded"),
    });

    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: reservationId,
        setup_intent_id: "seti_confirmed",
      }),
    );

    expect(response.status).toBe(200);
    expect(await bodyOf(response)).toEqual({ ok: true });
    expect(await cardOnFile(reservationId)).toBe(1);
  });

  it("leaves card_on_file at 0 while the intent still needs a payment method", async () => {
    const reservationId = await reserveSuccessfully("seti_pending");
    stubStripe({
      method: "GET",
      path: "/v1/setup_intents/seti_pending",
      body: setupIntentPayload("seti_pending", "requires_payment_method"),
    });

    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: reservationId,
        setup_intent_id: "seti_pending",
      }),
    );

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({
      error: "setup intent not complete: requires_payment_method",
    });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("refuses an id that is not the stored one without calling Stripe at all", async () => {
    // No interceptor is registered for this id on purpose: the endpoint must
    // decide from the row. Reaching Stripe would both amplify one cheap POST
    // into an API call against our rate limit and turn the 502/409 split into
    // an existence oracle for arbitrary seti_ ids in our account.
    const reservationId = await reserveSuccessfully("seti_mine");
    const recorder = recordFetches();

    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: reservationId,
        setup_intent_id: "seti_0000000000000000000000",
      }),
    );
    recorder.restore();

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({ error: "setup_intent_id does not match reservation" });
    expect(recorder.urls).toEqual([]);
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("502s when Stripe is unreachable while reading the stored intent", async () => {
    const reservationId = await reserveSuccessfully("seti_outage");
    stubStripe({
      method: "GET",
      path: "/v1/setup_intents/seti_outage",
      status: 503,
      body: { error: { type: "api_error", message: "down" } },
    });

    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: reservationId,
        setup_intent_id: "seti_outage",
      }),
    );

    expect(response.status).toBe(502);
    expect(await bodyOf(response)).toEqual({ error: "payment provider unavailable" });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("404s an unknown reservation without asking Stripe", async () => {
    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: "00000000-0000-4000-8000-000000000000",
        setup_intent_id: "seti_whatever",
      }),
    );

    expect(response.status).toBe(404);
    expect(await bodyOf(response)).toEqual({ error: "reservation not found" });
  });

  it("rejects a setup_intent_id that is not a Stripe id", async () => {
    const reservationId = await reserveSuccessfully("seti_guard");

    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: reservationId,
        setup_intent_id: "../customers/cus_test",
      }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: "setup_intent_id: expected a Stripe SetupIntent id",
    });
    expect(await cardOnFile(reservationId)).toBe(0);
  });
});

describe("POST /api/stripe/webhook", () => {
  const nowSeconds = (): number => Math.floor(Date.now() / 1000);

  it("flips card_on_file for the reservation a signed setup_intent.succeeded names", async () => {
    // The backstop for a visitor whose tab closed before /api/reserve/confirm.
    const reservationId = await reserveSuccessfully("seti_hooked");
    const raw = setupIntentSucceededEvent(reservationId, "seti_hooked");

    const response = await postWebhook(raw, await stripeSignatureHeader(raw, nowSeconds()));

    expect(response.status).toBe(200);
    expect(await cardOnFile(reservationId)).toBe(1);
  });

  // Pads an otherwise valid event so the body crosses a size threshold. Stripe
  // sends a full object graph; our fixtures are small, so the padding stands in
  // for the fields we do not read.
  function paddedEvent(reservationId: string, setupIntentId: string, bytes: number): string {
    const event = JSON.parse(setupIntentSucceededEvent(reservationId, setupIntentId));
    event.data.object.description = "x".repeat(bytes);
    return JSON.stringify(event);
  }

  it("accepts a signed delivery over the 4096-byte JSON cap, which this path cannot use", async () => {
    // Signature verification needs the exact bytes, so this route reads text
    // rather than going through the JSON parser and its 4096-byte cap. Routing
    // it through that parser would reject real Stripe events, which are several
    // KB. `content-length` is declared, so the cap is genuinely consulted and
    // seen to pass rather than being skipped for want of a header.
    const reservationId = await reserveSuccessfully("seti_large");
    const raw = paddedEvent(reservationId, "seti_large", 5000);

    expect(new TextEncoder().encode(raw).byteLength).toBeGreaterThan(4096);

    const response = await postWebhook(raw, await stripeSignatureHeader(raw, nowSeconds()), {
      "content-length": String(raw.length),
    });

    expect(response.status).toBe(200);
    expect(await cardOnFile(reservationId)).toBe(1);
  });

  it.each([
    ["declares its length", true],
    ["declines to declare one", false],
  ])("refuses a delivery over the 65536-byte cap that %s", async (_label, declare) => {
    // The second case is the one that matters. `content-length` is absent on a
    // chunked or streamed upload, and workerd does not synthesise it, so a cap
    // that trusted the header alone would let an unsigned caller make us buffer
    // and HMAC an arbitrary payload.
    const reservationId = await reserveSuccessfully(`seti_huge_${declare}`);
    const raw = paddedEvent(reservationId, `seti_huge_${declare}`, 70000);
    const signature = await stripeSignatureHeader(raw, nowSeconds());

    const response = await postWebhook(
      raw,
      signature,
      declare ? { "content-length": String(raw.length) } : {},
    );

    expect(response.status).toBe(413);
    expect(await bodyOf(response)).toEqual({ error: "body: must be at most 65536 bytes" });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("refuses an unsigned delivery", async () => {
    const reservationId = await reserveSuccessfully("seti_unsigned");
    const raw = setupIntentSucceededEvent(reservationId, "seti_unsigned");

    const response = await postWebhook(raw, null);

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "stripe-signature: missing" });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("refuses a delivery signed with the wrong secret", async () => {
    const reservationId = await reserveSuccessfully("seti_forged");
    const raw = setupIntentSucceededEvent(reservationId, "seti_forged");

    const response = await postWebhook(
      raw,
      await stripeSignatureHeader(raw, nowSeconds(), "whsec_not_ours"),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "stripe-signature: verification failed" });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("refuses a correctly signed delivery replayed outside the tolerance window", async () => {
    const reservationId = await reserveSuccessfully("seti_stale");
    const raw = setupIntentSucceededEvent(reservationId, "seti_stale");

    const response = await postWebhook(raw, await stripeSignatureHeader(raw, nowSeconds() - 600));

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: "stripe-signature: timestamp outside tolerance",
    });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("refuses every delivery when no webhook secret is configured", async () => {
    const reservationId = await reserveSuccessfully("seti_nosecret");
    const raw = setupIntentSucceededEvent(reservationId, "seti_nosecret");
    const signature = await stripeSignatureHeader(raw, nowSeconds());

    const ctx = createExecutionContext();
    const response = await handleApi(
      new Request("https://cadbabel.com/api/stripe/webhook", {
        method: "POST",
        headers: { "content-type": "application/json", "stripe-signature": signature },
        body: raw,
      }),
      apiEnv({ STRIPE_WEBHOOK_SECRET: undefined }),
      ctx,
    );
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(500);
    expect(await bodyOf(response)).toEqual({ error: "internal" });
    expect(await cardOnFile(reservationId)).toBe(0);
  });

  it("acknowledges an event for an unknown reservation without flipping anything", async () => {
    const reservationId = await reserveSuccessfully("seti_known");
    const raw = setupIntentSucceededEvent("00000000-0000-4000-8000-000000000000", "seti_unknown");

    const response = await postWebhook(raw, await stripeSignatureHeader(raw, nowSeconds()));

    expect(response.status).toBe(200);
    expect(await cardOnFile(reservationId)).toBe(0);
    expect(await countRows("reservations")).toBe(1);
  });

  it("acknowledges other signed event types without flipping anything", async () => {
    const reservationId = await reserveSuccessfully("seti_failed");
    const raw = JSON.stringify({
      id: "evt_test_failed",
      type: "setup_intent.setup_failed",
      data: { object: { id: "seti_failed", metadata: { reservation_id: reservationId } } },
    });

    const response = await postWebhook(raw, await stripeSignatureHeader(raw, nowSeconds()));

    expect(response.status).toBe(200);
    expect(await cardOnFile(reservationId)).toBe(0);
  });
});

describe("GET /api/stats", () => {
  const statsRequest = (token?: string): Request =>
    new Request("https://cadbabel.com/api/stats", {
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });

  it("401s without a token and advertises the scheme", async () => {
    const response = await call(statsRequest());

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="cadbabel-stats"');
    expect(await bodyOf(response)).toEqual({ error: "unauthorized" });
  });

  it("401s a wrong token of the same length", async () => {
    const wrong = `${"x".repeat(STATS_TOKEN.length - 1)}y`;
    const response = await call(statsRequest(wrong));

    expect(response.status).toBe(401);
  });

  it("401s an empty bearer value even when the configured token is empty", async () => {
    const response = await call(statsRequest(""), apiEnv({ STATS_TOKEN: "" }));

    expect(response.status).toBe(401);
  });

  it("aggregates views, doors, reservations and cards per direction", async () => {
    const seed = [
      "INSERT INTO events (kind, direction) VALUES ('page_view', NULL)",
      "INSERT INTO events (kind, direction) VALUES ('page_view', NULL)",
      "INSERT INTO events (kind, direction) VALUES ('page_view', NULL)",
      "INSERT INTO events (kind, direction) VALUES ('door_select', 'sw-to-fusion')",
      "INSERT INTO events (kind, direction) VALUES ('door_select', 'sw-to-fusion')",
      "INSERT INTO events (kind, direction) VALUES ('door_select', 'fusion-to-sw')",
      `INSERT INTO reservations (id, email, direction, purpose, disclosure_shown_at, disclosure_ack, card_on_file)
         VALUES ('r1', 'a@example.com', 'sw-to-fusion', 'product', '${DISCLOSURE_SHOWN_AT}', 1, 1)`,
      `INSERT INTO reservations (id, email, direction, purpose, disclosure_shown_at, disclosure_ack, card_on_file)
         VALUES ('r2', 'b@example.com', 'sw-to-fusion', 'hobby', '${DISCLOSURE_SHOWN_AT}', 1, 0)`,
      `INSERT INTO reservations (id, email, direction, purpose, disclosure_shown_at, disclosure_ack, card_on_file)
         VALUES ('r3', 'c@example.com', 'fusion-to-sw', 'client-deliverable', '${DISCLOSURE_SHOWN_AT}', 1, 0)`,
    ];
    for (const statement of seed) {
      await env.DB.prepare(statement).run();
    }

    const response = await call(statsRequest(STATS_TOKEN));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await bodyOf(response)).toEqual({
      totals: { page_views: 3, door_selects: 3, reservations: 3, card_on_file: 1 },
      directions: {
        "sw-to-fusion": { page_views: 0, door_selects: 2, reservations: 2, card_on_file: 1 },
        "fusion-to-sw": { page_views: 0, door_selects: 1, reservations: 1, card_on_file: 0 },
      },
    });
  });
});
