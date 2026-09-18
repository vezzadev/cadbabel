/**
 * Minimal typed Stripe REST client.
 *
 * Deliberately hand-rolled over `fetch` instead of the `stripe` npm package:
 * the fake door needs exactly three calls, and the SDK drags in a Node HTTP
 * stack we would then have to shim on Workers.
 */

const API_BASE = "https://api.stripe.com/v1";

/**
 * Who is at fault for a failed Stripe call. Carried as an enum rather than a
 * boolean because it crosses a module boundary and decides what the visitor is
 * told: "configuration" is ours (bad or revoked key, malformed request) and
 * must never be reported as a third-party outage; "upstream" is Stripe's
 * (rate limit, 5xx, network, unparseable response) and legitimately is.
 */
export type StripeFault = "configuration" | "upstream";

export class StripeError extends Error {
  readonly httpStatus: number;
  readonly code: string | null;
  readonly fault: StripeFault;

  constructor(httpStatus: number, code: string | null, fault: StripeFault, message: string) {
    super(message);
    this.name = "StripeError";
    this.httpStatus = httpStatus;
    this.code = code;
    this.fault = fault;
  }
}

export type SetupIntentStatus =
  | "requires_payment_method"
  | "requires_confirmation"
  | "requires_action"
  | "processing"
  | "canceled"
  | "succeeded";

const SETUP_INTENT_STATUSES: readonly SetupIntentStatus[] = [
  "requires_payment_method",
  "requires_confirmation",
  "requires_action",
  "processing",
  "canceled",
  "succeeded",
];

export interface StripeCustomer {
  readonly id: string;
}

export interface StripeSetupIntent {
  readonly id: string;
  readonly status: SetupIntentStatus;
  readonly clientSecret: string;
  readonly customerId: string | null;
}

/**
 * A 401/403, or any `invalid_request_error`, means the key we hold is wrong or
 * the request we built is wrong. Both are our defects: retrying does not help
 * and Stripe is not down. Everything else — 429, 5xx, anything unexpected — is
 * treated as upstream.
 */
function classify(httpStatus: number, type: string | null): StripeFault {
  if (httpStatus === 401 || httpStatus === 403) return "configuration";
  if (type === "invalid_request_error") return "configuration";
  return "upstream";
}

async function request(
  secretKey: string,
  method: "GET" | "POST",
  path: string,
  form?: URLSearchParams,
  idempotencyKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${secretKey}`,
    accept: "application/json",
  };
  if (form) headers["content-type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: form ? form.toString() : undefined,
    });
  } catch (cause) {
    // We never reached Stripe: no request was made, so the caller may retry.
    const detail = cause instanceof Error ? cause.message : typeof cause;
    throw new StripeError(502, "network_error", "upstream", `stripe ${method} ${path}: ${detail}`);
  }
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    // Never interpolate the secret key or the request body into the message:
    // this string ends up in Worker logs.
    const error = (payload as { error?: { code?: unknown; message?: unknown; type?: unknown } } | null)
      ?.error;
    const code = typeof error?.code === "string" ? error.code : null;
    const type = typeof error?.type === "string" ? error.type : null;
    const detail = typeof error?.message === "string" ? error.message : "no error message";
    throw new StripeError(
      response.status,
      code,
      classify(response.status, type),
      `stripe ${method} ${path}: ${response.status} ${detail}`,
    );
  }
  return payload;
}

function readString(payload: unknown, field: string, path: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new StripeError(502, "malformed_response", "upstream", `stripe ${path}: missing ${field}`);
  }
  return value;
}

export async function createCustomer(
  secretKey: string,
  params: {
    email: string;
    reservationId: string;
    direction: string;
    purpose: string;
    environment: string;
  },
): Promise<StripeCustomer> {
  const form = new URLSearchParams();
  form.set("email", params.email);
  form.set("metadata[reservation_id]", params.reservationId);
  form.set("metadata[direction]", params.direction);
  form.set("metadata[purpose]", params.purpose);
  // Both environments share one Stripe test account, so PPE smoke traffic and
  // real demand are only separable in the dashboard if every object says which
  // one made it.
  form.set("metadata[environment]", params.environment);

  const payload = await request(secretKey, "POST", "/customers", form, `${params.reservationId}:customer`);
  return { id: readString(payload, "id", "/customers") };
}

export async function createSetupIntent(
  secretKey: string,
  params: { customerId: string; reservationId: string; environment: string },
): Promise<StripeSetupIntent> {
  const form = new URLSearchParams();
  form.set("customer", params.customerId);
  form.set("usage", "off_session");
  form.set("payment_method_types[0]", "card");
  form.set("metadata[reservation_id]", params.reservationId);
  form.set("metadata[environment]", params.environment);

  const payload = await request(secretKey, "POST", "/setup_intents", form, `${params.reservationId}:setup_intent`);
  return asSetupIntent(payload, "/setup_intents");
}

export async function getSetupIntent(secretKey: string, setupIntentId: string): Promise<StripeSetupIntent> {
  const path = `/setup_intents/${encodeURIComponent(setupIntentId)}`;
  return asSetupIntent(await request(secretKey, "GET", path), path);
}

function asSetupIntent(payload: unknown, path: string): StripeSetupIntent {
  const status = (payload as Record<string, unknown> | null)?.["status"];
  if (typeof status !== "string" || !SETUP_INTENT_STATUSES.includes(status as SetupIntentStatus)) {
    throw new StripeError(502, "malformed_response", "upstream", `stripe ${path}: unknown status`);
  }
  const customerId = (payload as Record<string, unknown>)["customer"];
  return {
    id: readString(payload, "id", path),
    status: status as SetupIntentStatus,
    clientSecret: readString(payload, "client_secret", path),
    customerId: typeof customerId === "string" ? customerId : null,
  };
}
