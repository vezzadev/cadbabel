import { createExecutionContext, env, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import initMigration from "../migrations/0001_init.sql?raw";
import isoTimestampsMigration from "../migrations/0002_iso_timestamps.sql?raw";
import { handleApi } from "../src/api/router";
import worker from "../src/index";

/**
 * The platform half of the contract: the entrypoint's `/api/` split, the
 * per-IP limiters, the request-size cap, the bearer scheme, and the `/api/stats`
 * window. `test/api.test.ts` drives the handlers; this file drives the Worker
 * as deployed — `SELF.fetch` goes through `src/index.ts`, which no test
 * exercised before, including the asset fallthrough the whole page depends on.
 *
 * The rate limit bindings are declared in both Wrangler files but the runtime
 * behind the Vitest pool (its own pinned Wrangler) does not know the
 * `ratelimits` field, so `env.EVENT_RATE_LIMIT` is absent here. The limiter
 * *numbers* are therefore verified against a real `wrangler dev` (recorded in
 * the PR), and the routing decisions — which limiter, which key, whether the
 * handler runs, which paths are exempt — are verified here against a faithful
 * fake of the one-method binding contract.
 */

/** The real migrations, replayed statement by statement (D1 has no multi-statement prepare). */
const SCHEMA_STATEMENTS = [initMigration, isoTimestampsMigration].flatMap((migration) =>
  migration
    .replace(/--[^\n]*/g, "")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0),
);

const ORIGIN = "https://cadbabel.com";

interface LimiterProbe extends RateLimit {
  readonly keys: string[];
}

/** A stand-in for the platform binding: one method, one boolean, keys recorded. */
function limiterProbe(success: boolean): LimiterProbe {
  const keys: string[] = [];
  return {
    keys,
    limit: async ({ key }) => {
      keys.push(key);
      return { success };
    },
  };
}

interface TestEnv {
  event: LimiterProbe;
  reserve: LimiterProbe;
  env: Env;
}

/** Stripe is left unconfigured so no handler can reach the network. */
function envWithLimiters(eventSuccess: boolean, reserveSuccess: boolean): TestEnv {
  const event = limiterProbe(eventSuccess);
  const reserve = limiterProbe(reserveSuccess);
  const base = { ...(env as unknown as Env) };
  delete base.STRIPE_SECRET_KEY;
  return { event, reserve, env: { ...base, EVENT_RATE_LIMIT: event, RESERVE_RATE_LIMIT: reserve } };
}

async function call(request: Request, environment: Env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await handleApi(request, environment, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

function jsonRequest(path: string, body: unknown, headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
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

function reserveBody(email: string, disclosureShownAt: string): Record<string, unknown> {
  return {
    email,
    direction: "sw-to-fusion",
    purpose: "hobby",
    needed_by: null,
    disclosure_ack: true,
    disclosure_shown_at: disclosureShownAt,
  };
}

beforeAll(async () => {
  for (const statement of SCHEMA_STATEMENTS) {
    await env.DB.prepare(statement).run();
  }
});

describe("src/index.ts entrypoint", () => {
  it("serves / from the asset binding, not from Worker code", async () => {
    const response = await SELF.fetch(`${ORIGIN}/`);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<!doctype html>");
  });

  it("routes /api/event to the API and records the event", async () => {
    const before = await countRows("events");
    const response = await SELF.fetch(
      new Request(`${ORIGIN}/api/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "door_select", direction: "fusion-to-sw" }),
      }),
    );

    expect(response.status).toBe(204);
    expect(await countRows("events")).toBe(before + 1);
  });

  /**
   * Through `SELF.fetch` the asset router answers `/api-notes` before the
   * Worker is ever invoked, so it cannot show which prefix the split uses.
   * Calling the entrypoint directly does: `startsWith("/api")` instead of
   * `startsWith("/api/")` turns this into Worker JSON.
   */
  it("hands a path that merely starts with /api to the asset binding", async () => {
    const { env: environment } = envWithLimiters(true, true);
    const ctx = createExecutionContext();
    const response = await worker.fetch(new Request(`${ORIGIN}/api-notes`), environment, ctx);
    await waitOnExecutionContext(ctx);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/html");
    expect(body).toContain("<!doctype html>");
  });

  it("stores an event timestamp that compares against a stats window", async () => {
    await SELF.fetch(
      new Request(`${ORIGIN}/api/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "page_view", direction: null }),
      }),
    );

    const row = await env.DB.prepare(
      "SELECT created_at FROM events ORDER BY id DESC LIMIT 1",
    ).first<{ created_at: string }>();

    expect(row?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("rate limiting", () => {
  it("refuses an over-limit /api/event before the handler writes a row", async () => {
    const { env: environment, event, reserve } = envWithLimiters(false, true);
    const before = await countRows("events");

    const response = await call(
      jsonRequest("/api/event", { kind: "door_select", direction: "sw-to-fusion" }, { "cf-connecting-ip": "203.0.113.7" }),
      environment,
    );

    expect(response.status).toBe(429);
    expect(await bodyOf(response)).toEqual({
      error: "too many requests from this address; wait a minute and try again",
    });
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await countRows("events")).toBe(before);
    expect(event.keys).toEqual(["203.0.113.7"]);
    expect(reserve.keys).toEqual([]);
  });

  it("keys the limiter on the client IP Cloudflare supplies, and collapses an absent one into a shared bucket", async () => {
    const { env: environment, event } = envWithLimiters(false, true);

    const response = await call(jsonRequest("/api/event", { kind: "page_view", direction: null }), environment);

    expect(response.status).toBe(429);
    expect(event.keys).toEqual(["no-client-ip"]);
  });

  it("charges /api/reserve and /api/reserve/confirm to one reservation bucket", async () => {
    const { env: environment, event, reserve } = envWithLimiters(true, true);

    const reserved = await call(
      jsonRequest("/api/reserve", reserveBody("bucket@example.com", new Date().toISOString()), {
        "cf-connecting-ip": "203.0.113.8",
      }),
      environment,
    );
    const confirmed = await call(
      jsonRequest(
        "/api/reserve/confirm",
        { reservation_id: crypto.randomUUID(), setup_intent_id: "seti_platformtest" },
        { "cf-connecting-ip": "203.0.113.8" },
      ),
      environment,
    );

    expect(reserved.status).toBe(201);
    expect(confirmed.status).toBe(404);
    expect(reserve.keys).toEqual(["203.0.113.8", "203.0.113.8"]);
    expect(event.keys).toEqual([]);
  });

  it("refuses an over-limit reservation on both reservation paths", async () => {
    const { env: environment } = envWithLimiters(true, false);

    const reserved = await call(
      jsonRequest("/api/reserve", reserveBody("throttled@example.com", new Date().toISOString())),
      environment,
    );
    const confirmed = await call(
      jsonRequest("/api/reserve/confirm", { reservation_id: crypto.randomUUID(), setup_intent_id: "seti_x" }),
      environment,
    );

    expect(reserved.status).toBe(429);
    expect(confirmed.status).toBe(429);
    expect(await countRows("reservations")).toBe(0);
  });

  it("never throttles the signature-verified Stripe webhook", async () => {
    const { env: environment, event, reserve } = envWithLimiters(false, false);

    const delivered = await call(jsonRequest("/api/stripe/webhook", { id: "evt_test" }), environment);
    const wrongMethod = await call(
      new Request(`${ORIGIN}/api/stripe/webhook`, { method: "GET" }),
      environment,
    );

    expect(delivered.status).not.toBe(429);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(event.keys).toEqual([]);
    expect(reserve.keys).toEqual([]);
  });
});

describe("request body cap", () => {
  it("refuses a body whose declared length is over 4096 bytes without parsing it", async () => {
    const response = await SELF.fetch(
      new Request(`${ORIGIN}/api/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "page_view", direction: null, pad: "a".repeat(5000) }),
      }),
    );

    expect(response.status).toBe(413);
    expect(await bodyOf(response)).toEqual({ error: "body: must be at most 4096 bytes" });
  });

  it("accepts a body under the cap that would fail validation, so the cap is not the only check", async () => {
    const response = await SELF.fetch(
      new Request(`${ORIGIN}/api/event`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "page_view", direction: null, pad: "a".repeat(100) }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({ error: "pad: unknown field" });
  });
});

describe("disclosure_shown_at", () => {
  it("refuses a timestamp that is not an ISO-8601 instant", async () => {
    const response = await SELF.fetch(
      jsonRequest("/api/reserve", reserveBody("noniso@example.com", "December 17, 1995")),
    );

    expect(response.status).toBe(400);
    expect(await bodyOf(response)).toEqual({
      error: "disclosure_shown_at: expected an ISO-8601 instant such as 2026-09-17T23:44:47.031Z",
    });
  });

  it("refuses an ISO instant from outside the window it claims to attest", async () => {
    const stale = await SELF.fetch(
      jsonRequest("/api/reserve", reserveBody("stale@example.com", "1995-12-17T00:00:00.000Z")),
    );
    const future = await SELF.fetch(
      jsonRequest(
        "/api/reserve",
        reserveBody("future@example.com", new Date(Date.now() + 60 * 60 * 1000).toISOString()),
      ),
    );

    expect(stale.status).toBe(400);
    expect(await bodyOf(stale)).toEqual({ error: "disclosure_shown_at: must be within the last 24 hours" });
    expect(future.status).toBe(400);
    expect(await bodyOf(future)).toEqual({ error: "disclosure_shown_at: must not be in the future" });
    expect(await countRows("reservations")).toBe(0);
  });

  it("accepts a recent instant with a numeric offset and stores it as UTC", async () => {
    const { env: environment } = envWithLimiters(true, true);
    const offsetForm = new Date(Date.now() - 60 * 1000).toISOString().replace("Z", "+00:00");

    const response = await call(
      jsonRequest("/api/reserve", reserveBody("offset@example.com", offsetForm)),
      environment,
    );
    const row = await env.DB.prepare("SELECT disclosure_shown_at FROM reservations WHERE email = ?")
      .bind("offset@example.com")
      .first<{ disclosure_shown_at: string }>();

    expect(response.status).toBe(201);
    expect(row?.disclosure_shown_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe("GET /api/stats", () => {
  const token = env.STATS_TOKEN ?? "";

  function statsRequest(query: string, authorization: string): Request {
    return new Request(`${ORIGIN}/api/stats${query}`, { headers: { authorization } });
  }

  it("matches the bearer scheme case-insensitively and the token exactly", async () => {
    const canonical = await SELF.fetch(statsRequest("", `Bearer ${token}`));
    const lowercase = await SELF.fetch(statsRequest("", `bearer ${token}`));
    const wrongToken = await SELF.fetch(statsRequest("", `bearer ${token}x`));

    expect(canonical.status).toBe(200);
    expect(lowercase.status).toBe(200);
    expect(wrongToken.status).toBe(401);
  });

  async function seedWindow(): Promise<void> {
    await env.DB.prepare("INSERT INTO events (kind, direction, created_at) VALUES (?, ?, ?)")
      .bind("door_select", "sw-to-fusion", "2026-01-01T00:00:00.000Z")
      .run();
    await env.DB.prepare("INSERT INTO events (kind, direction, created_at) VALUES (?, ?, ?)")
      .bind("door_select", "sw-to-fusion", "2026-06-01T00:00:00.000Z")
      .run();
    await env.DB.prepare(
      `INSERT INTO reservations
         (id, email, direction, purpose, needed_by, disclosure_shown_at, disclosure_ack, card_on_file, created_at)
       VALUES (?, ?, 'sw-to-fusion', 'hobby', NULL, ?, 1, ?, ?)`,
    )
      .bind(crypto.randomUUID(), "january@example.com", "2026-01-01T00:00:00.000Z", 0, "2026-01-01T00:00:00.000Z")
      .run();
    await env.DB.prepare(
      `INSERT INTO reservations
         (id, email, direction, purpose, needed_by, disclosure_shown_at, disclosure_ack, card_on_file, created_at)
       VALUES (?, ?, 'sw-to-fusion', 'hobby', NULL, ?, 1, ?, ?)`,
    )
      .bind(crypto.randomUUID(), "june@example.com", "2026-06-01T00:00:00.000Z", 1, "2026-06-01T00:00:00.000Z")
      .run();
  }

  async function totals(query: string): Promise<Record<string, number>> {
    const response = await SELF.fetch(statsRequest(query, `Bearer ${token}`));
    expect(response.status).toBe(200);
    const body = await bodyOf(response);
    return body["totals"] as Record<string, number>;
  }

  it("windows both aggregates with ?since= and ?until=", async () => {
    await seedWindow();

    expect(await totals("")).toMatchObject({ door_selects: 2, reservations: 2, card_on_file: 1 });
    expect(await totals("?since=2026-03-01T00:00:00Z")).toMatchObject({
      door_selects: 1,
      reservations: 1,
      card_on_file: 1,
    });
    expect(await totals("?until=2026-03-01T00:00:00Z")).toMatchObject({
      door_selects: 1,
      reservations: 1,
      card_on_file: 0,
    });
    expect(await totals("?since=2026-02-01T00:00:00Z&until=2026-03-01T00:00:00Z")).toMatchObject({
      door_selects: 0,
      reservations: 0,
      card_on_file: 0,
    });
  });

  it("includes a row whose created_at equals an inclusive bound", async () => {
    await seedWindow();

    expect(await totals("?since=2026-06-01T00:00:00.000Z")).toMatchObject({ door_selects: 1, reservations: 1 });
    expect(await totals("?until=2026-01-01T00:00:00.000Z")).toMatchObject({ door_selects: 1, reservations: 1 });
  });

  it("refuses a malformed bound instead of silently reporting every row", async () => {
    const since = await SELF.fetch(statsRequest("?since=notadate", `Bearer ${token}`));
    const until = await SELF.fetch(statsRequest("?until=December%2017,%201995", `Bearer ${token}`));

    expect(since.status).toBe(400);
    expect(await bodyOf(since)).toEqual({
      error: "since: expected an ISO-8601 instant such as 2026-09-17T23:44:47.031Z",
    });
    expect(until.status).toBe(400);
    expect(await bodyOf(until)).toEqual({
      error: "until: expected an ISO-8601 instant such as 2026-09-17T23:44:47.031Z",
    });
  });
});
