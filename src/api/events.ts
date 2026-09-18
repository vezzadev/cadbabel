import { ApiError, emptyResponse, readJsonBody, rejectUnknownFields, requiredEnum } from "./http";

export const DIRECTIONS = ["sw-to-fusion", "fusion-to-sw"] as const;
export type Direction = (typeof DIRECTIONS)[number];

const KINDS = ["page_view", "door_select"] as const;

/**
 * POST /api/event — the only telemetry the page emits. No cookies, no vendor,
 * no identifiers: two counters keyed by (kind, direction).
 */
export async function handleEvent(request: Request, env: Env): Promise<Response> {
  const body = await readJsonBody(request);
  rejectUnknownFields(body, ["kind", "direction"]);

  const kind = requiredEnum(body, "kind", KINDS);
  if (!("direction" in body)) {
    throw new ApiError(400, "direction: required (null for page_view)");
  }
  const rawDirection = body["direction"];

  let direction: Direction | null;
  if (kind === "door_select") {
    direction = requiredEnum(body, "direction", DIRECTIONS);
  } else {
    if (rawDirection !== null) throw new ApiError(400, "direction: must be null for page_view");
    direction = null;
  }

  // created_at is written here, not left to the column default: every stored
  // timestamp is ISO-8601 UTC with a T and a Z so the two tables compare.
  await env.DB.prepare("INSERT INTO events (kind, direction, created_at) VALUES (?, ?, ?)")
    .bind(kind, direction, new Date().toISOString())
    .run();
  return emptyResponse(204);
}
