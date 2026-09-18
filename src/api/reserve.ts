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

/**
 * Names the index, not just "UNIQUE constraint failed": `reservations` also has
 * a unique index on `stripe_setup_intent_id`, and a violation of that one is a
 * server-side invariant breach, not a visitor reusing their email address.
 */
const EMAIL_TAKEN_PATTERN = /UNIQUE constraint failed: reservations\.email/i;

/** Stripe outages are upstream failures, not client mistakes: they surface as 502. */
const STRIPE_UNAVAILABLE = "payment provider unavailable";

interface ReservationRow {
  id: string;
  stripe_customer_id: string | null;
  stripe_setup_intent_id: string | null;
  card_on_file: number;
}

/**
 * How the request got hold of the row it is about to attach Stripe ids to.
 * An enum rather than a boolean because it crosses a function boundary and
 * decides whether a Stripe failure may delete the row: `inserted` rows are
 * ours to roll back, `recovered` rows predate this request and must survive.
 */
type EmailClaim = "inserted" | "recovered";

interface ClaimedReservation {
  reservationId: string;
  claim: EmailClaim;
}

interface ReservationFields {
  email: string;
  direction: string;
  purpose: string;
  neededBy: string | null;
  disclosureShownAt: string;
}

/**
 * A Stripe failure that is our own misconfiguration must not tell the visitor
 * that Stripe is down — on a page whose entire pitch is honest copy, stating a
 * false fact about a named third party is the wrong default, and the fault code
 * is ours. Outages, rate limits and unparseable responses stay 502.
 */
function stripeApiError(cause: unknown): unknown {
  if (!(cause instanceof StripeError)) return cause;
  if (cause.fault === "upstream") return new ApiError(502, STRIPE_UNAVAILABLE);
  console.error("stripe misconfiguration", cause.message);
  return new ApiError(500, "internal");
}

/**
 * Claims the email with the INSERT, so the unique index — not a read-then-write
 * check — decides who wins between two concurrent requests for the same
 * address.
 *
 * On a collision the row is re-read instead of answering 409 flat. A row with
 * no SetupIntent is a reservation that never got to park a card: it was taken
 * while Stripe was unconfigured, or its Stripe call failed, or the UPDATE that
 * patches the ids in failed. Those rows have no other route back — confirm 409s
 * on a NULL intent and there is no third verb — so the retry recovers them and
 * `card_on_file`, the one number this door exists to measure, stays reachable.
 * 409 is reserved for the case where the email really is spoken for: a row that
 * already has a SetupIntent.
 */
async function claimReservation(env: Env, fields: ReservationFields): Promise<ClaimedReservation> {
  const reservationId = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO reservations
         (id, email, direction, purpose, needed_by, disclosure_shown_at, disclosure_ack, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
    )
      .bind(
        reservationId,
        fields.email,
        fields.direction,
        fields.purpose,
        fields.neededBy,
        fields.disclosureShownAt,
        new Date().toISOString(),
      )
      .run();
    return { reservationId, claim: "inserted" };
  } catch (cause) {
    if (!(cause instanceof Error) || !EMAIL_TAKEN_PATTERN.test(cause.message)) throw cause;

    const existing = await env.DB.prepare(
      `SELECT id, stripe_customer_id, stripe_setup_intent_id, card_on_file
         FROM reservations WHERE email = ?`,
    )
      .bind(fields.email)
      .first<ReservationRow>();
    // The row that just rejected our INSERT is gone already: the state is
    // inconsistent, not a duplicate, and a retry will now succeed.
    if (!existing) throw cause;
    if (existing.stripe_setup_intent_id) throw new ApiError(409, "email already reserved");
    if (existing.card_on_file === 1) throw new ApiError(409, "email already reserved");
    return { reservationId: existing.id, claim: "recovered" };
  }
}

/**
 * Removes a row this request inserted moments ago after Stripe refused to play.
 * Never touches a `recovered` row: that reservation existed before this request
 * and deleting it would throw away someone's earlier intent.
 */
async function rollbackClaim(env: Env, claimed: ClaimedReservation): Promise<void> {
  if (claimed.claim === "recovered") return;
  try {
    // Guarded on card_on_file = 0 so it can never remove a reservation that has
    // already parked a card.
    await env.DB.prepare("DELETE FROM reservations WHERE id = ? AND card_on_file = 0")
      .bind(claimed.reservationId)
      .run();
  } catch (cause) {
    // Not swallowed: the row now claims the email with no Stripe ids, which the
    // recovery path in claimReservation picks up on the next attempt. Log it and
    // let the original Stripe failure surface to the visitor.
    console.error(
      "reserve rollback failed",
      claimed.reservationId,
      cause instanceof Error ? cause.message : typeof cause,
    );
  }
}

/**
 * Creates the Stripe objects for a claimed row and patches their ids in. The
 * idempotency keys are seeded from the row id, so a retry against a recovered
 * row reuses the same keys and Stripe replays the original customer and
 * SetupIntent instead of minting duplicates.
 */
async function attachStripe(
  env: Env,
  secretKey: string,
  claimed: ClaimedReservation,
  fields: ReservationFields,
): Promise<string> {
  let customerId: string;
  let setupIntentId: string;
  let clientSecret: string;
  try {
    const customer = await createCustomer(secretKey, {
      email: fields.email,
      reservationId: claimed.reservationId,
      direction: fields.direction,
      purpose: fields.purpose,
      environment: env.ENVIRONMENT,
    });
    customerId = customer.id;
    const intent = await createSetupIntent(secretKey, {
      customerId: customer.id,
      reservationId: claimed.reservationId,
      environment: env.ENVIRONMENT,
    });
    setupIntentId = intent.id;
    clientSecret = intent.clientSecret;
  } catch (cause) {
    await rollbackClaim(env, claimed);
    throw stripeApiError(cause);
  }

  try {
    await env.DB.prepare(
      "UPDATE reservations SET stripe_customer_id = ?, stripe_setup_intent_id = ? WHERE id = ?",
    )
      .bind(customerId, setupIntentId, claimed.reservationId)
      .run();
  } catch (cause) {
    // The SetupIntent exists at Stripe but the row cannot name it. Handing the
    // client_secret out now would park a card against a row that says 0 and
    // confirm would refuse it, so fail instead: the row keeps the email, and a
    // retry recovers it and reuses the same Stripe objects via the idempotency
    // key seeded from this id.
    console.error(
      "reserve could not store stripe ids",
      claimed.reservationId,
      cause instanceof Error ? cause.message : typeof cause,
    );
    throw new ApiError(500, "internal");
  }

  return clientSecret;
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
 * failed attempt leaves neither a row nor a usable client_secret behind — but
 * only a row this request inserted, never one it recovered from an earlier
 * attempt that never reached Stripe.
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

  const fields: ReservationFields = { email, direction, purpose, neededBy, disclosureShownAt };
  const claimed = await claimReservation(env, fields);

  // The door can be live before Stripe is. With no keys configured the
  // reservation still counts; the page then tells the visitor, in those words,
  // that card capture is not wired up yet. `card_step` carries that state so
  // the client never has to infer it from a missing field. Such a row is not
  // stranded: a later attempt with the same email recovers it above.
  //
  // Read into locals so the narrowing survives: an unset Worker secret is
  // absent from `env` entirely, not empty.
  const secretKey = env.STRIPE_SECRET_KEY;
  const publishableKey = env.STRIPE_PUBLISHABLE_KEY;
  if (!secretKey || !publishableKey) {
    return jsonResponse(
      {
        reservation_id: claimed.reservationId,
        card_step: "unconfigured",
        client_secret: null,
        publishable_key: null,
      },
      201,
    );
  }

  const clientSecret = await attachStripe(env, secretKey, claimed, fields);

  return jsonResponse(
    {
      reservation_id: claimed.reservationId,
      card_step: "stripe",
      client_secret: clientSecret,
      publishable_key: publishableKey,
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
    `SELECT id, stripe_customer_id, stripe_setup_intent_id, card_on_file
       FROM reservations WHERE id = ?`,
  )
    .bind(reservationId)
    .first<ReservationRow>();
  if (!row) throw new ApiError(404, "reservation not found");
  if (!row.stripe_setup_intent_id) throw new ApiError(409, "reservation has no setup intent");

  // Match first, then ask Stripe. Comparing the client's id against the stored
  // one is exactly as safe against substitution as comparing Stripe's echo of
  // it, because the id below is read from the row and never from the request —
  // and it keeps a caller holding one reservation id of their own from using
  // this endpoint as an existence oracle for arbitrary seti_ ids, or as an
  // unthrottled amplifier against our Stripe rate limit.
  if (setupIntentId !== row.stripe_setup_intent_id) {
    throw new ApiError(409, "setup_intent_id does not match reservation");
  }

  const secretKey = env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    console.error("confirm called with no stripe secret configured", row.id);
    throw new ApiError(500, "internal");
  }

  let status: string;
  let customerId: string | null;
  try {
    const intent = await getSetupIntent(secretKey, row.stripe_setup_intent_id);
    status = intent.status;
    customerId = intent.customerId;
  } catch (cause) {
    throw stripeApiError(cause);
  }

  if (customerId !== row.stripe_customer_id) {
    // Our two ids disagree about who the intent belongs to. That is a defect in
    // our own data, not something the client did.
    console.error("stored setup intent belongs to another customer", row.id);
    throw new ApiError(500, "internal");
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
