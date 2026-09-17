/**
 * Minimal typed Stripe REST client.
 *
 * Deliberately hand-rolled over `fetch` instead of the `stripe` npm package:
 * the fake door needs exactly three calls, and the SDK drags in a Node HTTP
 * stack we would then have to shim on Workers.
 */

const API_BASE = "https://api.stripe.com/v1";

export class StripeError extends Error {
  readonly httpStatus: number;
  readonly code: string | null;

  constructor(httpStatus: number, code: string | null, message: string) {
    super(message);
    this.name = "StripeError";
    this.httpStatus = httpStatus;
    this.code = code;
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

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: form ? form.toString() : undefined,
  });
  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    // Never interpolate the secret key or the request body into the message:
    // this string ends up in Worker logs.
    const error = (payload as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "string" ? error.code : null;
    const detail = typeof error?.message === "string" ? error.message : "no error message";
    throw new StripeError(response.status, code, `stripe ${method} ${path}: ${response.status} ${detail}`);
  }
  return payload;
}

function readString(payload: unknown, field: string, path: string): string {
  const value = (payload as Record<string, unknown> | null)?.[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new StripeError(502, "malformed_response", `stripe ${path}: missing ${field}`);
  }
  return value;
}

export async function createCustomer(
  secretKey: string,
  params: { email: string; reservationId: string; direction: string; purpose: string },
): Promise<StripeCustomer> {
  const form = new URLSearchParams();
  form.set("email", params.email);
  form.set("metadata[reservation_id]", params.reservationId);
  form.set("metadata[direction]", params.direction);
  form.set("metadata[purpose]", params.purpose);

  const payload = await request(secretKey, "POST", "/customers", form, `${params.reservationId}:customer`);
  return { id: readString(payload, "id", "/customers") };
}

export async function createSetupIntent(
  secretKey: string,
  params: { customerId: string; reservationId: string },
): Promise<StripeSetupIntent> {
  const form = new URLSearchParams();
  form.set("customer", params.customerId);
  form.set("usage", "off_session");
  form.set("payment_method_types[0]", "card");
  form.set("metadata[reservation_id]", params.reservationId);

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
    throw new StripeError(502, "malformed_response", `stripe ${path}: unknown status`);
  }
  const customerId = (payload as Record<string, unknown>)["customer"];
  return {
    id: readString(payload, "id", path),
    status: status as SetupIntentStatus,
    clientSecret: readString(payload, "client_secret", path),
    customerId: typeof customerId === "string" ? customerId : null,
  };
}
