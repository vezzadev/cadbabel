/** Response builders and hand-written request validation shared by the API routes. */

export type JsonRecord = Record<string, unknown>;

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

/** Accepts any parseable instant and normalises it to UTC ISO-8601 for storage. */
export function requiredTimestamp(body: JsonRecord, field: string): string {
  const raw = requiredString(body, field, 64);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new ApiError(400, `${field}: expected an ISO-8601 timestamp`);
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
