import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  JOB_NAMES,
  queueJobDataSchema,
  type QueueJobData,
} from "../../app/queues/jobs.js";
import { QUEUE_NAMES } from "../../app/queues/queue-names.js";
import {
  createShopifyOrder,
  type ShopifyOrderCreateResult,
} from "../../app/services/orders/order-create.server.js";
import { reconcileShopifyOrder } from "../../app/services/orders/order-reconcile.server.js";
import {
  claimOrderIntentForProcessing,
  claimOrderIntentForReconciliation,
  deferOrderIntentWithoutClaim,
  markOrderIntentAmbiguous,
  markOrderIntentPermanentFailure,
  markOrderIntentSucceeded,
  releaseOrderIntentReconciliation,
  scheduleOrderIntentRetry,
} from "../../app/services/orders/order-state.server.js";
import {
  ShopifyRateGate,
  ShopifyRateLimitDeferredError,
  type RateLimitedGraphqlClient,
  withShopifyRateGate,
} from "../../app/services/shopify/shopify-rate-gate.server.js";
import {
  createSilentLogger,
  type Logger,
} from "../../app/services/logging/logger.server.js";
import type { ProcessableJob } from "./maintenance.processor.js";

const orderJobPayloadSchema = z.object({
  orderIntentId: z.string().min(1),
  delayMs: z.number().int().nonnegative().optional(),
});

export class OrderWorkDeferredError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number, message = "Order work was deferred") {
    super(message);
    this.name = "OrderWorkDeferredError";
    this.retryAfterMs = Math.max(1, Math.ceil(retryAfterMs));
  }
}

export interface OrderProcessorOptions {
  prisma: PrismaClient;
  rateGate: ShopifyRateGate;
  orderCreateEstimatedCost: number;
  orderReconcileEstimatedCost: number;
  reconciliationDelayMs: number;
  reconciliationMaxAttempts: number;
  processingLeaseMs: number;
  getAdmin?: (shopDomain: string) => Promise<RateLimitedGraphqlClient>;
  now?: () => Date;
  random?: () => number;
  logger?: Logger;
}

export async function processOrderJob(
  job: ProcessableJob<QueueJobData>,
  options: OrderProcessorOptions,
) {
  const data = queueJobDataSchema.parse(job.data);
  const payload = orderJobPayloadSchema.parse(data.payload);
  if (
    data.aggregateType !== "OrderIntent" ||
    data.aggregateId !== payload.orderIntentId
  ) {
    throw new Error("Order queue payload does not match its aggregate");
  }

  if (job.name === JOB_NAMES.orderCreate) {
    return processOrderCreate(data, payload.orderIntentId, options, job);
  }
  if (job.name === JOB_NAMES.orderReconcileAmbiguous) {
    return processOrderReconciliation(
      data,
      payload.orderIntentId,
      options,
      job,
    );
  }
  throw new Error(`Unsupported order job type: ${job.name}`);
}

async function processOrderCreate(
  data: QueueJobData,
  orderIntentId: string,
  options: OrderProcessorOptions,
  job: ProcessableJob<QueueJobData>,
) {
  const now = options.now?.() ?? new Date();
  const current = await options.prisma.orderIntent.findFirst({
    where: { id: orderIntentId, shopId: data.shopId },
    include: { shop: true },
  });
  if (!current) return { status: "stale" as const, orderIntentId };
  if (current.shopifyOrderGid || current.status === "SUCCEEDED") {
    return { status: "already-succeeded" as const, orderIntentId };
  }
  if (current.status === "PROCESSING") {
    const leaseRemaining = current.processingStartedAt
      ? current.processingStartedAt.getTime() +
        options.processingLeaseMs -
        now.getTime()
      : 0;
    if (leaseRemaining > 0) {
      throw new OrderWorkDeferredError(leaseRemaining);
    }
    await markOrderIntentAmbiguous(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      message:
        "A previous worker stopped during order creation; reconciliation is required before any further write.",
      reconcileDelayMs: options.reconciliationDelayMs,
      now,
    });
    return { status: "ambiguous" as const, orderIntentId };
  }
  if (current.nextAttemptAt && current.nextAttemptAt > now) {
    throw new OrderWorkDeferredError(
      current.nextAttemptAt.getTime() - now.getTime(),
    );
  }

  const capabilityDelayMs = 15 * 60 * 1000;
  if (current.shop.status !== "ACTIVE") {
    await deferOrderIntentWithoutClaim(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      category: "SHOP_UNINSTALLED",
      code: "SHOP_NOT_ACTIVE",
      message: "Order creation is paused because the shop is not active.",
      nextAttemptAt: new Date(now.getTime() + capabilityDelayMs),
    });
    throw new OrderWorkDeferredError(capabilityDelayMs);
  }
  if (!hasScope(current.shop.grantedScopes, "write_orders")) {
    await deferOrderIntentWithoutClaim(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      category: "MISSING_SCOPE",
      code: "WRITE_ORDERS_REQUIRED",
      message: "Order creation is paused until write_orders is granted.",
      nextAttemptAt: new Date(now.getTime() + capabilityDelayMs),
    });
    throw new OrderWorkDeferredError(capabilityDelayMs);
  }

  const intent = await claimOrderIntentForProcessing(options.prisma, {
    shopId: data.shopId,
    orderIntentId,
    now,
  });
  if (!intent) return { status: "not-claimed" as const, orderIntentId };

  let admin: RateLimitedGraphqlClient;
  try {
    admin = await getAdmin(options, intent.shop.domain);
  } catch {
    const delayMs = retryDelay(intent.attemptCount, options.random);
    await scheduleOrderIntentRetry(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      category: "AUTHENTICATION",
      code: "ADMIN_CLIENT_UNAVAILABLE",
      message: "Shopify authentication is temporarily unavailable.",
      nextAttemptAt: new Date(now.getTime() + delayMs),
    });
    throw new OrderWorkDeferredError(delayMs);
  }

  const rateLimitedAdmin = withShopifyRateGate(admin, {
    rateGate: options.rateGate,
    shopId: data.shopId,
    estimatedCost: options.orderCreateEstimatedCost,
    priority: "order",
  });

  let result: ShopifyOrderCreateResult;
  try {
    result = await createShopifyOrder(rateLimitedAdmin, intent);
  } catch (error) {
    if (!(error instanceof ShopifyRateLimitDeferredError)) throw error;
    await scheduleOrderIntentRetry(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      category: "THROTTLED",
      code: "RATE_GATE_DEFERRED",
      message: "Order creation is waiting for Shopify API capacity.",
      nextAttemptAt: new Date(now.getTime() + error.retryAfterMs),
    });
    throw new OrderWorkDeferredError(error.retryAfterMs);
  }

  if (result.outcome === "succeeded") {
    await markOrderIntentSucceeded(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      shopifyOrderGid: result.orderGid,
      shopifyOrderName: result.orderName,
      now,
    });
    log(options, "order.create.succeeded", data, job, orderIntentId);
    return { status: "succeeded" as const, orderIntentId };
  }
  if (result.outcome === "ambiguous") {
    await markOrderIntentAmbiguous(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      message: result.message,
      reconcileDelayMs: options.reconciliationDelayMs,
      now,
    });
    log(options, "order.create.ambiguous", data, job, orderIntentId);
    return { status: "ambiguous" as const, orderIntentId };
  }
  if (result.outcome === "retry") {
    const delayMs =
      result.category === "THROTTLED"
        ? Math.max(options.reconciliationDelayMs, 1_000)
        : retryDelay(intent.attemptCount, options.random);
    await scheduleOrderIntentRetry(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      category: result.category,
      code: result.code,
      message: result.message,
      nextAttemptAt: new Date(now.getTime() + delayMs),
    });
    throw new OrderWorkDeferredError(delayMs);
  }
  if (result.category === "MISSING_SCOPE") {
    await scheduleOrderIntentRetry(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      category: "MISSING_SCOPE",
      code: result.code,
      message: result.message,
      nextAttemptAt: new Date(now.getTime() + capabilityDelayMs),
    });
    throw new OrderWorkDeferredError(capabilityDelayMs);
  }

  await markOrderIntentPermanentFailure(options.prisma, {
    shopId: data.shopId,
    orderIntentId,
    category: result.category,
    code: result.code,
    message: result.message,
  });
  log(options, "order.create.permanent_failure", data, job, orderIntentId);
  return { status: "permanent-failure" as const, orderIntentId };
}

async function processOrderReconciliation(
  data: QueueJobData,
  orderIntentId: string,
  options: OrderProcessorOptions,
  job: ProcessableJob<QueueJobData>,
) {
  const now = options.now?.() ?? new Date();
  const current = await options.prisma.orderIntent.findFirst({
    where: { id: orderIntentId, shopId: data.shopId },
    include: { shop: true },
  });
  if (!current) return { status: "stale" as const, orderIntentId };
  if (current.shopifyOrderGid || current.status === "SUCCEEDED") {
    return { status: "already-succeeded" as const, orderIntentId };
  }
  if (current.status !== "AMBIGUOUS_RESULT" || !current.sourceIdentifier) {
    return { status: "not-ambiguous" as const, orderIntentId };
  }
  if (current.processingStartedAt) {
    const leaseRemaining =
      current.processingStartedAt.getTime() +
      options.processingLeaseMs -
      now.getTime();
    if (leaseRemaining > 0) {
      throw new OrderWorkDeferredError(leaseRemaining);
    }
    await releaseOrderIntentReconciliation(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      message:
        "A previous reconciliation worker stopped; the safe read will resume.",
      nextAttemptAt: now,
    });
  }
  if (current.nextAttemptAt && current.nextAttemptAt > now) {
    throw new OrderWorkDeferredError(
      current.nextAttemptAt.getTime() - now.getTime(),
    );
  }
  if (
    current.shop.status !== "ACTIVE" ||
    !hasScope(current.shop.grantedScopes, "read_orders")
  ) {
    const delayMs = 15 * 60 * 1000;
    await releaseOrderIntentReconciliation(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      message: "Order reconciliation is paused until order access is restored.",
      nextAttemptAt: new Date(now.getTime() + delayMs),
    });
    throw new OrderWorkDeferredError(delayMs);
  }

  const intent = await claimOrderIntentForReconciliation(options.prisma, {
    shopId: data.shopId,
    orderIntentId,
    now,
  });
  if (!intent) return { status: "not-claimed" as const, orderIntentId };

  let admin: RateLimitedGraphqlClient;
  try {
    admin = await getAdmin(options, intent.shop.domain);
  } catch {
    return deferReconciliation(
      options,
      intent,
      now,
      "Shopify authentication is temporarily unavailable.",
    );
  }
  const rateLimitedAdmin = withShopifyRateGate(admin, {
    rateGate: options.rateGate,
    shopId: data.shopId,
    estimatedCost: options.orderReconcileEstimatedCost,
    priority: "order",
  });

  try {
    const result = await reconcileShopifyOrder(
      rateLimitedAdmin,
      intent.sourceIdentifier!,
    );
    if (result.outcome === "found") {
      await markOrderIntentSucceeded(options.prisma, {
        shopId: data.shopId,
        orderIntentId,
        shopifyOrderGid: result.orderGid,
        shopifyOrderName: result.orderName,
        now,
        allowedStatuses: ["AMBIGUOUS_RESULT"],
      });
      log(options, "order.reconcile.succeeded", data, job, orderIntentId);
      return { status: "reconciled" as const, orderIntentId };
    }
    if (result.outcome === "multiple") {
      await releaseOrderIntentReconciliation(options.prisma, {
        shopId: data.shopId,
        orderIntentId,
        message:
          "Multiple Shopify orders match this source identifier; merchant review is required.",
        nextAttemptAt: null,
      });
      return { status: "multiple" as const, orderIntentId };
    }
    if (
      result.outcome === "not-found" &&
      intent.reconciliationAttemptCount >= options.reconciliationMaxAttempts
    ) {
      await releaseOrderIntentReconciliation(options.prisma, {
        shopId: data.shopId,
        orderIntentId,
        message:
          "No Shopify order was found after bounded reconciliation; merchant review is required.",
        nextAttemptAt: null,
      });
      return { status: "not-found-final" as const, orderIntentId };
    }
    return deferReconciliation(
      options,
      intent,
      now,
      result.outcome === "retry"
        ? result.message
        : "The Shopify order is not visible yet; reconciliation will retry.",
    );
  } catch (error) {
    if (!(error instanceof ShopifyRateLimitDeferredError)) throw error;
    await releaseOrderIntentReconciliation(options.prisma, {
      shopId: data.shopId,
      orderIntentId,
      message: "Order reconciliation is waiting for Shopify API capacity.",
      nextAttemptAt: new Date(now.getTime() + error.retryAfterMs),
    });
    throw new OrderWorkDeferredError(error.retryAfterMs);
  }
}

async function deferReconciliation(
  options: OrderProcessorOptions,
  intent: { id: string; shopId: string; reconciliationAttemptCount: number },
  now: Date,
  message: string,
): Promise<never> {
  const delayMs = retryDelay(intent.reconciliationAttemptCount, options.random);
  await releaseOrderIntentReconciliation(options.prisma, {
    shopId: intent.shopId,
    orderIntentId: intent.id,
    message,
    nextAttemptAt: new Date(now.getTime() + delayMs),
  });
  throw new OrderWorkDeferredError(delayMs);
}

async function getAdmin(options: OrderProcessorOptions, shopDomain: string) {
  if (options.getAdmin) return options.getAdmin(shopDomain);
  const { unauthenticated } = await import("../../app/shopify.server.js");
  const result = await unauthenticated.admin(shopDomain);
  return result.admin;
}

function retryDelay(attempt: number, random: (() => number) | undefined) {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return base + Math.floor((random?.() ?? Math.random()) * 500);
}

function hasScope(scopes: string | null, required: string) {
  return new Set(
    (scopes ?? "")
      .split(",")
      .map((scope) => scope.trim())
      .filter(Boolean),
  ).has(required);
}

function log(
  options: OrderProcessorOptions,
  message: string,
  data: QueueJobData,
  job: ProcessableJob<QueueJobData>,
  orderIntentId: string,
) {
  (options.logger ?? createSilentLogger()).info(message, {
    operationName: job.name,
    queueName: QUEUE_NAMES.orderWrite,
    shopId: data.shopId,
    orderIntentId,
    outboxEventId: data.eventId,
    jobId: job.id,
  });
}
