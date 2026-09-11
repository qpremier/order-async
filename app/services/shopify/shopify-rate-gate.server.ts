import type { Redis } from "ioredis";

const RESERVE_BUDGET_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local estimatedCost = tonumber(ARGV[2])
local safetyMargin = tonumber(ARGV[3])
local fallbackMaximum = tonumber(ARGV[4])
local fallbackRestoreRate = tonumber(ARGV[5])
local background = ARGV[6] == "1"

local maximum = tonumber(redis.call("HGET", key, "maximum")) or fallbackMaximum
local available = tonumber(redis.call("HGET", key, "available")) or fallbackMaximum
local restoreRate = tonumber(redis.call("HGET", key, "restoreRate")) or fallbackRestoreRate
local observedAt = tonumber(redis.call("HGET", key, "observedAt")) or now
local elapsedSeconds = math.max(0, now - observedAt) / 1000
available = math.min(maximum, available + (elapsedSeconds * restoreRate))

local paddedCost = estimatedCost / safetyMargin
local backgroundReserve = 0
if background then
  backgroundReserve = maximum * (1 - safetyMargin)
end
local required = paddedCost + backgroundReserve

local allowed = 0
local waitMs = 0
if available >= required then
  allowed = 1
  available = math.max(0, available - estimatedCost)
else
  waitMs = math.ceil(((required - available) / math.max(restoreRate, 0.001)) * 1000)
end

redis.call("HSET", key,
  "maximum", maximum,
  "available", available,
  "restoreRate", restoreRate,
  "observedAt", now)
redis.call("PEXPIRE", key, 3600000)

return { allowed, waitMs, available, maximum, restoreRate }
`;

const OBSERVE_BUDGET_SCRIPT = `
local key = KEYS[1]
redis.call("HSET", key,
  "maximum", ARGV[1],
  "available", ARGV[2],
  "restoreRate", ARGV[3],
  "observedAt", ARGV[4])
redis.call("PEXPIRE", key, 3600000)
return 1
`;

export type ShopifyRatePriority = "order" | "background";

export interface ShopifyThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface ShopifyRateReservation {
  allowed: boolean;
  retryAfterMs: number;
  currentlyAvailable: number;
  maximumAvailable: number;
  restoreRate: number;
}

export interface ShopifyRateGateOptions {
  redis: Pick<Redis, "eval">;
  safetyMargin: number;
  fallbackMaximumAvailable: number;
  fallbackRestoreRate: number;
  now?: () => number;
  jitter?: () => number;
  keyPrefix?: string;
}

export class ShopifyRateLimitDeferredError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("Shopify rate budget is temporarily unavailable");
    this.name = "ShopifyRateLimitDeferredError";
    this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
  }
}

export class ShopifyRateGate {
  private readonly redis: Pick<Redis, "eval">;
  private readonly safetyMargin: number;
  private readonly fallbackMaximumAvailable: number;
  private readonly fallbackRestoreRate: number;
  private readonly now: () => number;
  private readonly jitter: () => number;
  private readonly keyPrefix: string;

  constructor(options: ShopifyRateGateOptions) {
    this.redis = options.redis;
    this.safetyMargin = options.safetyMargin;
    this.fallbackMaximumAvailable = options.fallbackMaximumAvailable;
    this.fallbackRestoreRate = options.fallbackRestoreRate;
    this.now = options.now ?? Date.now;
    this.jitter = options.jitter ?? Math.random;
    this.keyPrefix = options.keyPrefix ?? "orderrelay:shopify-rate";
  }

  async reserve(
    shopId: string,
    estimatedCost: number,
    priority: ShopifyRatePriority,
  ): Promise<ShopifyRateReservation> {
    const raw = await this.redis.eval(
      RESERVE_BUDGET_SCRIPT,
      1,
      this.key(shopId),
      this.now(),
      estimatedCost,
      this.safetyMargin,
      this.fallbackMaximumAvailable,
      this.fallbackRestoreRate,
      priority === "background" ? 1 : 0,
    );
    const result = parseReservation(raw);

    if (!result.allowed) {
      result.retryAfterMs += Math.floor(this.jitter() * 250) + 50;
    }

    return result;
  }

  async observe(
    shopId: string,
    throttleStatus: ShopifyThrottleStatus,
  ): Promise<void> {
    await this.redis.eval(
      OBSERVE_BUDGET_SCRIPT,
      1,
      this.key(shopId),
      throttleStatus.maximumAvailable,
      throttleStatus.currentlyAvailable,
      throttleStatus.restoreRate,
      this.now(),
    );
  }

  private key(shopId: string) {
    return `${this.keyPrefix}:${shopId}`;
  }
}

export interface RateLimitedGraphqlClient {
  graphql(
    query: string,
    options?: { variables?: Record<string, unknown> },
  ): Promise<{ json(): Promise<unknown> }>;
}

export function withShopifyRateGate(
  client: RateLimitedGraphqlClient,
  options: {
    rateGate: ShopifyRateGate;
    shopId: string;
    estimatedCost: number;
    priority: ShopifyRatePriority;
  },
): RateLimitedGraphqlClient {
  return {
    async graphql(query, requestOptions) {
      const reservation = await options.rateGate.reserve(
        options.shopId,
        options.estimatedCost,
        options.priority,
      );
      if (!reservation.allowed) {
        throw new ShopifyRateLimitDeferredError(reservation.retryAfterMs);
      }

      const response = await client.graphql(query, requestOptions);
      let parsedBody: unknown;
      let bodyLoaded = false;

      return {
        async json() {
          if (!bodyLoaded) {
            parsedBody = await response.json();
            bodyLoaded = true;
            const throttleStatus = extractShopifyThrottleStatus(parsedBody);
            if (throttleStatus) {
              await options.rateGate.observe(options.shopId, throttleStatus);
            }
            if (hasThrottleError(parsedBody)) {
              const retryAfterMs = throttleStatus
                ? Math.max(
                    1_000,
                    Math.ceil(
                      ((options.estimatedCost -
                        throttleStatus.currentlyAvailable) /
                        Math.max(throttleStatus.restoreRate, 0.001)) *
                        1_000,
                    ),
                  )
                : 1_000;
              throw new ShopifyRateLimitDeferredError(retryAfterMs);
            }
          }
          return parsedBody;
        },
      };
    },
  };
}

function hasThrottleError(body: unknown) {
  if (!isRecord(body) || !Array.isArray(body.errors)) return false;
  return body.errors.some(
    (error) =>
      isRecord(error) &&
      isRecord(error.extensions) &&
      error.extensions.code === "THROTTLED",
  );
}

export function extractShopifyThrottleStatus(
  body: unknown,
): ShopifyThrottleStatus | null {
  if (!isRecord(body)) return null;
  const extensions = body.extensions;
  if (!isRecord(extensions)) return null;
  const cost = extensions.cost;
  if (!isRecord(cost)) return null;
  const status = cost.throttleStatus;
  if (!isRecord(status)) return null;

  const maximumAvailable = toFiniteNumber(status.maximumAvailable);
  const currentlyAvailable = toFiniteNumber(status.currentlyAvailable);
  const restoreRate = toFiniteNumber(status.restoreRate);
  if (
    maximumAvailable === null ||
    currentlyAvailable === null ||
    restoreRate === null ||
    maximumAvailable <= 0 ||
    restoreRate <= 0
  ) {
    return null;
  }

  return { maximumAvailable, currentlyAvailable, restoreRate };
}

function parseReservation(value: unknown): ShopifyRateReservation {
  if (!Array.isArray(value) || value.length < 5) {
    throw new Error("Redis returned an invalid Shopify rate reservation");
  }

  return {
    allowed: toFiniteNumber(value[0]) === 1,
    retryAfterMs: Math.max(0, toFiniteNumber(value[1]) ?? 0),
    currentlyAvailable: toFiniteNumber(value[2]) ?? 0,
    maximumAvailable: toFiniteNumber(value[3]) ?? 0,
    restoreRate: toFiniteNumber(value[4]) ?? 0,
  };
}

function toFiniteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
