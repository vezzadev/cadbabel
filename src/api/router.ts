import { handleEvent } from "./events";
import { ApiError, jsonResponse } from "./http";
import { handleReserve, handleReserveConfirm } from "./reserve";
import { handleStats } from "./stats";
import { handleStripeWebhook } from "./webhook";

type ApiHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>;

const ROUTES: Record<string, Partial<Record<string, ApiHandler>>> = {
  "/api/event": { POST: handleEvent },
  "/api/reserve": { POST: handleReserve },
  "/api/reserve/confirm": { POST: handleReserveConfirm },
  "/api/stats": { GET: handleStats },
  "/api/stripe/webhook": { POST: handleStripeWebhook },
};

/**
 * Which limiter guards which path. Every counter this API keeps is the output
 * of the demand test, so a number anyone can move with a for-loop is not
 * evidence; `/api/reserve*` additionally spends a third party's quota. The
 * Stripe webhook is deliberately absent: it is signature-verified, and
 * throttling it would drop `setup_intent.succeeded` deliveries on the floor.
 */
const LIMITERS: Record<string, (env: Env) => RateLimit | undefined> = {
  "/api/event": (env) => env.EVENT_RATE_LIMIT,
  "/api/reserve": (env) => env.RESERVE_RATE_LIMIT,
  "/api/reserve/confirm": (env) => env.RESERVE_RATE_LIMIT,
};

/** The limiter's own retry window: both bindings are configured with a 60s period. */
const RETRY_AFTER_SECONDS = "60";

/**
 * Keyed on the client IP that Cloudflare puts in front of us. An absent header
 * (local `wrangler dev`, a direct handler call in a test) collapses to one
 * shared bucket rather than a free pass, so nothing is throttle-exempt just by
 * omitting a header a client cannot set anyway.
 */
async function enforceRateLimit(name: string, limiter: RateLimit | undefined, request: Request): Promise<void> {
  if (!limiter) {
    console.error("rate limit binding missing", name);
    return;
  }
  const key = request.headers.get("cf-connecting-ip") ?? "no-client-ip";
  const { success } = await limiter.limit({ key });
  if (success) return;
  throw new ApiError(429, "too many requests from this address; wait a minute and try again", {
    "retry-after": RETRY_AFTER_SECONDS,
  });
}

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

    const limiter = LIMITERS[normalized];
    if (limiter) await enforceRateLimit(normalized, limiter(env), request);

    return await handler(request, env, ctx);
  } catch (cause) {
    if (cause instanceof ApiError) {
      return jsonResponse({ error: cause.message }, cause.status, cause.headers);
    }
    // Anything else is ours, not the client's: no message, no code, no stack.
    console.error("unhandled api error", cause instanceof Error ? cause.message : typeof cause);
    return jsonResponse({ error: "internal" }, 500);
  }
}
