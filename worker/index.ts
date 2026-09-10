import db from "../app/db.server.js";
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
  const workers = createQueueWorkers({
    redisUrl: environment.REDIS_URL,
    prisma: db,
    orderConcurrency: environment.ORDER_WORKER_CONCURRENCY,
    catalogConcurrency: environment.CATALOG_WORKER_CONCURRENCY,
    logger,
  });
  const dispatcher = new OutboxDispatcher({
    prisma: db,
    publisher: new BullMqOutboxPublisher(queues),
    batchSize: environment.OUTBOX_BATCH_SIZE,
    pollIntervalMs: environment.OUTBOX_POLL_INTERVAL_MS,
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

    await dispatcher.stop();
    await Promise.all(workers.map((worker) => worker.close()));
    await queues.close();
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
