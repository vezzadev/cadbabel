import { DIRECTIONS } from "./events";
import {
  ApiError,
  jsonResponse,
  optionalDate,
  readJsonBody,
  rejectUnknownFields,
  requiredEmail,
  requiredEnum,
  requiredOpaqueId,
  requiredTimestamp,
  requiredTrue,
} from "./http";
import { createCustomer, createSetupIntent, getSetupIntent, StripeError } from "./stripe";

const PURPOSES = ["client-deliverable", "product", "hobby"] as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SETUP_INTENT_PATTERN = /^seti_[A-Za-z0-9_]+$/;

/** Stripe outages are upstream failures, not client mistakes: they surface as 502. */
const STRIPE_UNAVAILABLE = "payment provider unavailable";

interface ReservationRow {
  id: string;
  stripe_setup_intent_id: string | null;
  card_on_file: number;
}

/**
 * POST /api/reserve — records intent and parks a card with a zero-amount
 * SetupIntent. Nothing is ever charged here.
 *
 * Ordering: the reservation row is inserted BEFORE Stripe is contacted, and the
 * Stripe ids are patched in afterwards. Reasons, in order of importance:
 *   1. A card can only ever be attached to a SetupIntent whose client_secret we
 *      handed out, and we only hand it out after the row exists. Contacting
 *      Stripe first would open a window where a SetupIntent (and therefore a
 *      possible attached payment method) exists with no row to account for it.
 *   2. The INSERT is what claims the email, so the unique index — not a
 *      read-then-write check — decides the 409, with no race between two
 *      concurrent requests for the same address.
 * If Stripe then fails we compensate by deleting the row we just wrote, so a
 * failed attempt leaves neither a row nor a usable client_secret behind.
 */
export async function handleReserve(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  rejectUnknownFields(body, [
    "email",
    "direction",
    "purpose",
    "needed_by",
    "disclosure_ack",
    "disclosure_shown_at",
  ]);

  const email = requiredEmail(body, "email");
  const direction = requiredEnum(body, "direction", DIRECTIONS);
  const purpose = requiredEnum(body, "purpose", PURPOSES);
  const neededBy = optionalDate(body, "needed_by");
  // Load-bearing: the reservation is only meaningful if the visitor confirmed
  // they were shown the "this is a demand test, nothing is charged" disclosure.
  requiredTrue(body, "disclosure_ack");
  const disclosureShownAt = requiredTimestamp(body, "disclosure_shown_at");

  const reservationId = crypto.randomUUID();

  try {
    await env.DB.prepare(
      `INSERT INTO reservations
         (id, email, direction, purpose, needed_by, disclosure_shown_at, disclosure_ack)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
    )
      .bind(reservationId, email, direction, purpose, neededBy, disclosureShownAt)
      .run();
  } catch (cause) {
    if (cause instanceof Error && /UNIQUE constraint failed/i.test(cause.message)) {
      throw new ApiError(409, "email already reserved");
    }
    throw cause;
  }

  // The door can be live before Stripe is. With no keys configured the
  // reservation still counts; the page then tells the visitor, in those words,
  // that card capture is not wired up yet. `card_step` carries that state so
  // the client never has to infer it from a missing field.
  //
  // Falsy, not `.length === 0`: an unset Worker secret is absent from `env`
  // entirely, so a length check throws a TypeError and the visitor gets a 500
  // on a row that was already written.
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PUBLISHABLE_KEY) {
    return jsonResponse(
      {
        reservation_id: reservationId,
        card_step: "unconfigured",
        client_secret: null,
        publishable_key: null,
      },
      201,
    );
  }

  let customerId: string;
  let clientSecret: string;
  let setupIntentId: string;
  try {
    const customer = await createCustomer(env.STRIPE_SECRET_KEY, {
      email,
      reservationId,
      direction,
      purpose,
    });
    customerId = customer.id;
    const intent = await createSetupIntent(env.STRIPE_SECRET_KEY, {
      customerId: customer.id,
      reservationId,
    });
    setupIntentId = intent.id;
    clientSecret = intent.clientSecret;
  } catch (cause) {
    // Compensating delete: guarded on card_on_file = 0 so it can never remove a
    // reservation that has already parked a card.
    await env.DB.prepare("DELETE FROM reservations WHERE id = ? AND card_on_file = 0")
      .bind(reservationId)
      .run()
      .catch(() => undefined);
    if (cause instanceof StripeError) throw new ApiError(502, STRIPE_UNAVAILABLE);
    throw cause;
  }

  await env.DB.prepare(
    "UPDATE reservations SET stripe_customer_id = ?, stripe_setup_intent_id = ? WHERE id = ?",
  )
    .bind(customerId, setupIntentId, reservationId)
    .run();

  return jsonResponse(
    {
      reservation_id: reservationId,
      card_step: "stripe",
      client_secret: clientSecret,
      publishable_key: env.STRIPE_PUBLISHABLE_KEY,
    },
    201,
  );
}

/**
 * POST /api/reserve/confirm — trusts Stripe, not the client. The SetupIntent is
 * re-read server side and must both belong to this reservation and have actually
 * succeeded before `card_on_file` flips.
 */
export async function handleReserveConfirm(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  rejectUnknownFields(body, ["reservation_id", "setup_intent_id"]);

  const reservationId = requiredOpaqueId(body, "reservation_id", UUID_PATTERN, "a reservation UUID");
  const setupIntentId = requiredOpaqueId(
    body,
    "setup_intent_id",
    SETUP_INTENT_PATTERN,
    "a Stripe SetupIntent id",
  );

  const row = await env.DB.prepare(
    "SELECT id, stripe_setup_intent_id, card_on_file FROM reservations WHERE id = ?",
  )
    .bind(reservationId)
    .first<ReservationRow>();
  if (!row) throw new ApiError(404, "reservation not found");
  if (!row.stripe_setup_intent_id) throw new ApiError(409, "reservation has no setup intent");

  let status: string;
  let returnedId: string;
  try {
    // Read back the id the CLIENT supplied, then compare it to the stored one.
    // Reading the stored id instead would make the comparison vacuous and let a
    // client substitute someone else's succeeded SetupIntent.
    const intent = await getSetupIntent(env.STRIPE_SECRET_KEY, setupIntentId);
    status = intent.status;
    returnedId = intent.id;
  } catch (cause) {
    if (cause instanceof StripeError) throw new ApiError(502, STRIPE_UNAVAILABLE);
    throw cause;
  }

  if (returnedId !== row.stripe_setup_intent_id) {
    throw new ApiError(409, "setup_intent_id does not match reservation");
  }
  if (status !== "succeeded") {
    throw new ApiError(409, `setup intent not complete: ${status}`);
  }

  await env.DB.prepare(
    "UPDATE reservations SET card_on_file = 1 WHERE id = ? AND stripe_setup_intent_id = ?",
  )
    .bind(row.id, row.stripe_setup_intent_id)
    .run();

  return jsonResponse({ ok: true });
}
