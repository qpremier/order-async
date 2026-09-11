import db from "../app/db.server.js";
import { createBullMqRedisConnection } from "../app/queues/connection.server.js";
import { createQueueRegistry } from "../app/queues/queues.server.js";
import {
  createLogger,
  sanitizeErrorMessage,
} from "../app/services/logging/logger.server.js";
import {
  BullMqOutboxPublisher,
  OutboxDispatcher,
} from "../app/services/outbox/dispatcher.server.js";
import { getEnvironment } from "../app/services/security/environment.server.js";
import { ShopifyRateGate } from "../app/services/shopify/shopify-rate-gate.server.js";
import { CatalogReconciliationScheduler } from "./catalog-reconciliation-scheduler.js";
import { createQueueWorkers } from "./queue-workers.js";

async function main() {
  const environment = getEnvironment();
  const logger = createLogger({
    level: environment.LOG_LEVEL,
    context: {
      processRole: "worker",
    },
  });
  const queues = createQueueRegistry({
    redisUrl: environment.REDIS_URL,
    jobMaxAttempts: environment.JOB_MAX_ATTEMPTS,
  });
  const rateGateRedis = createBullMqRedisConnection(environment.REDIS_URL, {
    connectionName: "orderrelay-shopify-rate-gate",
  });
  const rateGate = new ShopifyRateGate({
    redis: rateGateRedis,
    safetyMargin: environment.RATE_LIMIT_SAFETY_MARGIN,
    fallbackMaximumAvailable: environment.RATE_LIMIT_FALLBACK_MAXIMUM_AVAILABLE,
    fallbackRestoreRate: environment.RATE_LIMIT_FALLBACK_RESTORE_RATE,
  });
  const workers = createQueueWorkers({
    redisUrl: environment.REDIS_URL,
    prisma: db,
    orderConcurrency: environment.ORDER_WORKER_CONCURRENCY,
    catalogConcurrency: environment.CATALOG_WORKER_CONCURRENCY,
    catalogPageSize: environment.CATALOG_SYNC_PAGE_SIZE,
    rateGate,
    orderCreateEstimatedCost: environment.SHOPIFY_ORDER_CREATE_ESTIMATED_COST,
    orderReconcileEstimatedCost:
      environment.SHOPIFY_ORDER_RECONCILE_ESTIMATED_COST,
    catalogQueryEstimatedCost: environment.SHOPIFY_CATALOG_QUERY_ESTIMATED_COST,
    reconciliationDelayMs: environment.ORDER_RECONCILIATION_DELAY_MS,
    reconciliationMaxAttempts: environment.ORDER_RECONCILIATION_MAX_ATTEMPTS,
    orderProcessingLeaseMs: environment.ORDER_PROCESSING_LEASE_MS,
    logger,
  });
  const dispatcher = new OutboxDispatcher({
    prisma: db,
    publisher: new BullMqOutboxPublisher(queues),
    batchSize: environment.OUTBOX_BATCH_SIZE,
    pollIntervalMs: environment.OUTBOX_POLL_INTERVAL_MS,
    logger,
  });
  const reconciliationScheduler = new CatalogReconciliationScheduler({
    prisma: db,
    staleAfterMinutes: environment.CATALOG_STALE_AFTER_MINUTES,
    logger,
  });

  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) {
      return;
    }

    shutdownStarted = true;
    logger.info("worker.shutdown.started", {
      operationName: "worker.shutdown",
      signal,
    });

    reconciliationScheduler.stop();
    await dispatcher.stop();
    await Promise.all(workers.map((worker) => worker.close()));
    await queues.close();
    await rateGateRedis.quit();
    await db.$disconnect();

    logger.info("worker.shutdown.completed", {
      operationName: "worker.shutdown",
      signal,
    });

    process.exit(0);
  };

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  void dispatcher.start();
  reconciliationScheduler.start();

  logger.info("worker.started", {
    operationName: "worker.start",
    orderConcurrency: environment.ORDER_WORKER_CONCURRENCY,
    catalogConcurrency: environment.CATALOG_WORKER_CONCURRENCY,
  });
}

main().catch(async (error) => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "worker.start_failed",
      processRole: "worker",
      operationName: "worker.start",
      error: sanitizeErrorMessage(error),
    }),
  );

  await db.$disconnect();
  process.exit(1);
});
