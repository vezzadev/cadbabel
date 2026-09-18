import { DIRECTIONS, type Direction } from "./events";
import { ApiError, jsonResponse, optionalIsoBound } from "./http";

interface EventAggregateRow {
  kind: string;
  direction: string | null;
  n: number;
}

interface ReservationAggregateRow {
  direction: string;
  reservations: number;
  card_on_file: number | null;
}

interface DirectionCounters {
  page_views: number;
  door_selects: number;
  reservations: number;
  card_on_file: number;
}

const UNAUTHORIZED_HEADERS = { "www-authenticate": 'Bearer realm="cadbabel-stats"' };

/**
 * GET /api/stats — the founder's dashboard, guarded by a shared bearer token.
 *
 * `page_views` is reported both per direction and as a total: a page_view
 * carries a null direction by contract, so today the per-direction figure is
 * always 0. It comes free from the same GROUP BY, and stays correct if the page
 * ever starts attributing views to a door.
 */
export async function handleStats(request: Request, env: Env): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  // RFC 7235 §2.1: the scheme is case-insensitive. The token is not.
  const presented = /^Bearer (.+)$/i.exec(header)?.[1]?.trim() ?? "";
  const expected = env.STATS_TOKEN ?? "";

  // Compare every byte: length first (lengths are not secret), then a full XOR
  // accumulation so a wrong token cannot be narrowed down byte by byte.
  const encoder = new TextEncoder();
  const presentedBytes = encoder.encode(presented);
  const expectedBytes = encoder.encode(expected);
  let mismatch = presentedBytes.length === 0 || presentedBytes.length !== expectedBytes.length ? 1 : 0;
  for (let i = 0; i < presentedBytes.length && i < expectedBytes.length; i++) {
    mismatch |= presentedBytes[i] ^ expectedBytes[i];
  }
  if (mismatch !== 0) throw new ApiError(401, "unauthorized", UNAUTHORIZED_HEADERS);

  // Optional window. `created_at` is ISO-8601 UTC with a T and a Z in both
  // tables, so a string comparison is a chronological one, and both bounds are
  // inclusive. Without them every row ever written is mixed into the number,
  // including smoke traffic.
  const params = new URL(request.url).searchParams;
  const since = optionalIsoBound(params, "since");
  const until = optionalIsoBound(params, "until");
  const clauses: string[] = [];
  const bounds: string[] = [];
  if (since !== null) {
    clauses.push("created_at >= ?");
    bounds.push(since);
  }
  if (until !== null) {
    clauses.push("created_at <= ?");
    bounds.push(until);
  }
  const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;

  const events = await env.DB.prepare(
    `SELECT kind, direction, COUNT(*) AS n FROM events${where} GROUP BY kind, direction`,
  )
    .bind(...bounds)
    .all<EventAggregateRow>();
  const reservations = await env.DB.prepare(
    `SELECT direction,
            COUNT(*) AS reservations,
            SUM(card_on_file) AS card_on_file
       FROM reservations${where}
      GROUP BY direction`,
  )
    .bind(...bounds)
    .all<ReservationAggregateRow>();

  const directions: Record<Direction, DirectionCounters> = {
    "sw-to-fusion": { page_views: 0, door_selects: 0, reservations: 0, card_on_file: 0 },
    "fusion-to-sw": { page_views: 0, door_selects: 0, reservations: 0, card_on_file: 0 },
  };
  const totals: DirectionCounters = { page_views: 0, door_selects: 0, reservations: 0, card_on_file: 0 };

  for (const row of events.results) {
    const metric = row.kind === "page_view" ? "page_views" : row.kind === "door_select" ? "door_selects" : null;
    if (!metric) continue;
    totals[metric] += row.n;
    const direction = DIRECTIONS.find((candidate) => candidate === row.direction);
    if (direction) directions[direction][metric] += row.n;
  }

  for (const row of reservations.results) {
    const cardOnFile = row.card_on_file ?? 0;
    totals.reservations += row.reservations;
    totals.card_on_file += cardOnFile;
    const direction = DIRECTIONS.find((candidate) => candidate === row.direction);
    if (direction) {
      directions[direction].reservations += row.reservations;
      directions[direction].card_on_file += cardOnFile;
    }
  }

  return jsonResponse({ totals, directions });
}
