import { handleEvent } from "./events";
import { ApiError, jsonResponse } from "./http";
import { handleReserve, handleReserveConfirm } from "./reserve";
import { handleStats } from "./stats";
import { StripeError } from "./stripe";

type ApiHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const ROUTES: Record<string, Partial<Record<string, ApiHandler>>> = {
  "/api/event": { POST: handleEvent },
  "/api/reserve": { POST: handleReserve },
  "/api/reserve/confirm": { POST: handleReserveConfirm },
  "/api/stats": { GET: handleStats },
};

/**
 * Sole entrypoint for /api/*. Everything it returns is JSON (or an empty 204)
 * and no-store; nothing a client sends is ever echoed back.
 */
export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  try {
    const { pathname } = new URL(request.url);
    const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;

    const methods = ROUTES[normalized];
    if (!methods) throw new ApiError(404, "not found");

    const handler = methods[request.method.toUpperCase()];
    if (!handler) {
      throw new ApiError(405, "method not allowed", { allow: Object.keys(methods).join(", ") });
    }

    return await handler(request, env, ctx);
  } catch (cause) {
    if (cause instanceof ApiError) {
      return jsonResponse({ error: cause.message }, cause.status, cause.headers);
    }
    if (cause instanceof StripeError) {
      return jsonResponse({ error: "payment provider unavailable" }, 502);
    }
    // Anything else is ours, not the client's: no message, no code, no stack.
    console.error("unhandled api error", cause instanceof Error ? cause.message : typeof cause);
    return jsonResponse({ error: "internal" }, 500);
  }
}
