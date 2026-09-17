import { createExecutionContext, env, fetchMock, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import schema from "../migrations/0001_init.sql?raw";
import { handleApi } from "../src/api/router";

const STATS_TOKEN = "stats-token-for-tests";
const STRIPE_SECRET_KEY = "sk_test_cadbabel";
const STRIPE_PUBLISHABLE_KEY = "pk_test_cadbabel";
const DISCLOSURE_SHOWN_AT = "2026-09-01T12:00:00.000Z";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The real migration, replayed statement by statement (D1 has no multi-statement prepare). */
const SCHEMA_STATEMENTS = schema
  .replace(/--[^\n]*/g, "")
  .split(";")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

function apiEnv(overrides: Partial<Env> = {}): Env {
  return {
    ...(env as unknown as Env),
    STRIPE_SECRET_KEY,
    STRIPE_PUBLISHABLE_KEY,
    STATS_TOKEN,
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

beforeAll(async () => {
  fetchMock.activate();
  fetchMock.disableNetConnect();
  await env.DB.prepare("DROP TABLE IF EXISTS events").run();
  await env.DB.prepare("DROP TABLE IF EXISTS reservations").run();
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
      second_yes: "no-reply",
    });
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
      apiEnv(keys as unknown as Partial<Env>),
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
    // The interceptors only match when the header is present and shaped
    // `<uuid>:customer` / `<uuid>:setup_intent`; otherwise the call is
    // unmatched, fetch rejects, and the route answers 502 instead of 201.
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

  it("409s a second reservation for the same email and keeps one row", async () => {
    await reserveSuccessfully("seti_first");

    const response = await call(jsonRequest("/api/reserve", reservePayload()));

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({ error: "email already reserved" });
    expect(await countRows("reservations")).toBe(1);
  });

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

  it("refuses a substituted succeeded intent that belongs to another reservation", async () => {
    const reservationId = await reserveSuccessfully("seti_mine");
    stubStripe({
      method: "GET",
      path: "/v1/setup_intents/seti_someone_else",
      body: setupIntentPayload("seti_someone_else", "succeeded"),
    });

    const response = await call(
      jsonRequest("/api/reserve/confirm", {
        reservation_id: reservationId,
        setup_intent_id: "seti_someone_else",
      }),
    );

    expect(response.status).toBe(409);
    expect(await bodyOf(response)).toEqual({ error: "setup_intent_id does not match reservation" });
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

    expect(wrong.length).toBe(STATS_TOKEN.length);
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
