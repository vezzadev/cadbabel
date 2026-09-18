import { ApiError, jsonResponse } from "./http";

/**
 * POST /api/stripe/webhook — the backstop for `card_on_file`.
 *
 * `/api/reserve/confirm` is the fast path, but it only runs if the visitor's tab
 * is still open when Stripe finishes: a closed tab, a navigation, or a dropped
 * connection between `confirmSetup` resolving and that POST leaves a card
 * parked at Stripe and the row saying 0, forever, with no symptom. Since
 * `card_on_file` is the one number this door exists to measure, Stripe gets to
 * tell us directly too.
 *
 * Anything we accept flips a row, so the signature is the only authentication
 * and it is checked before the body is looked at.
 */

/** Stripe's own replay window. A delivery signed outside it is refused. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

/** Generous next to a real `setup_intent.succeeded`, which is a few KB. */
const MAX_WEBHOOK_BYTES = 65536;

interface StripeSignature {
  /** Verbatim, because it is part of the signed payload. */
  timestamp: string;
  signatures: readonly string[];
}

function parseSignatureHeader(header: string): StripeSignature {
  let timestamp = "";
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }
  return { timestamp, signatures };
}

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return Array.from(new Uint8Array(mac))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Leaks only the length, which is fixed for a SHA-256 hex digest. */
function equalsConstantTime(presented: string, expected: string): boolean {
  if (presented.length !== expected.length) return false;
  let mismatch = 0;
  for (let index = 0; index < presented.length; index += 1) {
    mismatch |= presented.charCodeAt(index) ^ expected.charCodeAt(index);
  }
  return mismatch === 0;
}

function readReservationId(payload: unknown): string | null {
  const object = (payload as { data?: { object?: unknown } } | null)?.data?.object;
  const metadata = (object as { metadata?: unknown } | null)?.metadata;
  const reservationId = (metadata as { reservation_id?: unknown } | null)?.reservation_id;
  if (typeof reservationId !== "string" || reservationId.length === 0) return null;
  return reservationId;
}

export async function handleStripeWebhook(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const secret = env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    // Unverifiable deliveries are not accepted, and an unset secret is our
    // defect rather than a malformed request.
    console.error("stripe webhook secret not configured");
    throw new ApiError(500, "internal");
  }

  const header = request.headers.get("stripe-signature");
  if (!header) throw new ApiError(400, "stripe-signature: missing");

  // This path cannot use the JSON parser's 4096-byte cap: the signature covers
  // the exact bytes sent, so the body must be read whole and as text. Stripe's
  // own events are a few KB, so an unsigned caller still cannot make us buffer
  // an arbitrary payload before the HMAC runs.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    throw new ApiError(413, `body: must be at most ${MAX_WEBHOOK_BYTES} bytes`);
  }

  const raw = await request.text();
  const { timestamp, signatures } = parseSignatureHeader(header);
  const signedAt = Number(timestamp);
  if (timestamp.length === 0 || !Number.isFinite(signedAt) || signatures.length === 0) {
    throw new ApiError(400, "stripe-signature: malformed");
  }
  if (Math.abs(Date.now() / 1000 - signedAt) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new ApiError(400, "stripe-signature: timestamp outside tolerance");
  }

  const expected = await hmacSha256Hex(secret, `${timestamp}.${raw}`);
  if (!signatures.some((candidate) => equalsConstantTime(candidate, expected))) {
    throw new ApiError(400, "stripe-signature: verification failed");
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new ApiError(400, "body: expected valid JSON");
  }

  // Everything else Stripe might send is acknowledged, not rejected: a 4xx only
  // buys us a retry loop for an event we were never going to act on.
  const type = (event as { type?: unknown } | null)?.type;
  if (type !== "setup_intent.succeeded") return jsonResponse({ received: true });

  const reservationId = readReservationId(event);
  if (!reservationId) {
    console.error("setup_intent.succeeded carries no reservation_id metadata");
    return jsonResponse({ received: true });
  }

  const result = await env.DB.prepare("UPDATE reservations SET card_on_file = 1 WHERE id = ?")
    .bind(reservationId)
    .run();
  if (result.meta.changes === 0) {
    console.error("stripe webhook names an unknown reservation", reservationId);
  }

  return jsonResponse({ received: true });
}
