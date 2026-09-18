/** Response builders and hand-written request validation shared by the API routes. */

export type JsonRecord = Record<string, unknown>;

/** Declared body length above which a request is refused unread. */
const MAX_BODY_BYTES = 4096;

/** A failure the client is allowed to see: `message` is returned verbatim as `{ error }`. */
export class ApiError extends Error {
  readonly status: number;
  readonly headers: Record<string, string>;

  constructor(status: number, message: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.headers = headers;
  }
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

export function emptyResponse(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
}

export async function readJsonBody(request: Request): Promise<JsonRecord> {
  const mime = (request.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mime !== "application/json") {
    throw new ApiError(415, "content-type: expected application/json");
  }
  // Every legitimate body on this API is under 400 bytes. Refuse an oversized
  // one from its declared length, before buffering a byte of it.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new ApiError(413, `body: must be at most ${MAX_BODY_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiError(400, "body: expected valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "body: expected a JSON object");
  }
  return parsed as JsonRecord;
}

/**
 * Field names are echoed in errors; submitted values never are. An unknown key
 * is a client bug (or a probe) and is rejected rather than silently dropped.
 */
export function rejectUnknownFields(body: JsonRecord, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw new ApiError(400, `${key}: unknown field`);
  }
}

export function requiredString(body: JsonRecord, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string") throw new ApiError(400, `${field}: expected a string`);
  const trimmed = value.trim();
  if (trimmed.length === 0) throw new ApiError(400, `${field}: must not be empty`);
  if (trimmed.length > maxLength) throw new ApiError(400, `${field}: must be at most ${maxLength} characters`);
  return trimmed;
}

export function requiredEnum<T extends string>(body: JsonRecord, field: string, allowed: readonly T[]): T {
  const value = body[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ApiError(400, `${field}: expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function requiredTrue(body: JsonRecord, field: string): void {
  if (body[field] !== true) throw new ApiError(400, `${field}: must be true`);
}

/** An ISO-8601 instant: date, `T`, time, and either `Z` or a numeric offset. */
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** Epoch milliseconds for an ISO-8601 instant, or `null` when the string is not one. */
function parseIsoInstant(raw: string): number | null {
  if (!ISO_INSTANT_PATTERN.test(raw)) return null;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

const ISO_INSTANT_EXPECTED = "an ISO-8601 instant such as 2026-09-17T23:44:47.031Z";
const MAX_TIMESTAMP_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/**
 * An ISO-8601 instant that has to have actually happened, normalised to UTC for
 * storage. `Date.parse` alone accepts `"December 17, 1995"`; a disclosure
 * claimed to have been shown three decades ago is not an audit trail, so the
 * value must also land inside `[now - 24h, now + 5min]`.
 */
export function requiredTimestamp(body: JsonRecord, field: string): string {
  const raw = requiredString(body, field, 64);
  const parsed = parseIsoInstant(raw);
  if (parsed === null) throw new ApiError(400, `${field}: expected ${ISO_INSTANT_EXPECTED}`);
  const now = Date.now();
  if (parsed > now + MAX_TIMESTAMP_SKEW_MS) throw new ApiError(400, `${field}: must not be in the future`);
  if (parsed < now - MAX_TIMESTAMP_AGE_MS) {
    throw new ApiError(400, `${field}: must be within the last 24 hours`);
  }
  return new Date(parsed).toISOString();
}

/**
 * An optional ISO-8601 query bound, normalised to UTC so it compares
 * lexicographically against the stored `created_at` strings. Present but
 * unparseable is a client bug, not a request for every row.
 */
export function optionalIsoBound(params: URLSearchParams, field: string): string | null {
  const raw = params.get(field);
  if (raw === null) return null;
  const parsed = parseIsoInstant(raw.trim());
  if (parsed === null) throw new ApiError(400, `${field}: expected ${ISO_INSTANT_EXPECTED}`);
  return new Date(parsed).toISOString();
}

/** `null`, a missing key, or a calendar date. Anything else is a client bug. */
export function optionalDate(body: JsonRecord, field: string): string | null {
  const value = body[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new ApiError(400, `${field}: expected null or a YYYY-MM-DD date`);
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed) || !Number.isFinite(Date.parse(trimmed))) {
    throw new ApiError(400, `${field}: expected null or a YYYY-MM-DD date`);
  }
  return trimmed;
}

const EMAIL_PATTERN = /^[^\s@,;:<>"'()[\]\\]+@[^\s@.,;:<>"'()[\]\\]+(\.[^\s@.,;:<>"'()[\]\\]+)+$/;

export function requiredEmail(body: JsonRecord, field: string): string {
  const raw = requiredString(body, field, 254).toLowerCase();
  if (!EMAIL_PATTERN.test(raw)) throw new ApiError(400, `${field}: expected an email address`);
  return raw;
}

/** Matches an opaque token without echoing it, so ids can be interpolated into a Stripe path. */
export function requiredOpaqueId(body: JsonRecord, field: string, pattern: RegExp, expected: string): string {
  const raw = requiredString(body, field, 255);
  if (!pattern.test(raw)) throw new ApiError(400, `${field}: expected ${expected}`);
  return raw;
}
