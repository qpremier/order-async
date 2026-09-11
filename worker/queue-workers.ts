import { DelayedError, Worker, type Job } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { createBullMqRedisConnection } from "../app/queues/connection.server.js";
import type { QueueJobData } from "../app/queues/jobs.js";
import { QUEUE_NAMES, type QueueName } from "../app/queues/queue-names.js";
import {
  createSilentLogger,
  sanitizeErrorMessage,
  type Logger,
} from "../app/services/logging/logger.server.js";
import { processCatalogJob } from "./processors/catalog.processor.js";
import { processMaintenanceJob } from "./processors/maintenance.processor.js";
import { processUnsupportedPhase2Job } from "./processors/unsupported.processor.js";
import {
  OrderWorkDeferredError,
  processOrderJob,
} from "./processors/order.processor.js";
import {
  ShopifyRateGate,
  ShopifyRateLimitDeferredError,
} from "../app/services/shopify/shopify-rate-gate.server.js";

export interface QueueWorkerOptions {
  redisUrl: string;
  prisma: PrismaClient;
  orderConcurrency: number;
  catalogConcurrency: number;
  catalogPageSize?: number;
  rateGate?: ShopifyRateGate;
  orderCreateEstimatedCost?: number;
  orderReconcileEstimatedCost?: number;
  catalogQueryEstimatedCost?: number;
  reconciliationDelayMs?: number;
  reconciliationMaxAttempts?: number;
  orderProcessingLeaseMs?: number;
  prefix?: string;
  logger?: Logger;
}

export function createQueueWorkers(options: QueueWorkerOptions) {
  const logger = options.logger ?? createSilentLogger();

  const workers = [
    createWorker({
      queueName: QUEUE_NAMES.orderWrite,
      redisUrl: options.redisUrl,
      concurrency: options.orderConcurrency,
      prefix: options.prefix,
      logger,
      processor: (job) => {
        if (!options.rateGate) {
          return processUnsupportedPhase2Job(job, QUEUE_NAMES.orderWrite);
        }
        return processOrderJob(job, {
          prisma: options.prisma,
          rateGate: options.rateGate,
          orderCreateEstimatedCost: options.orderCreateEstimatedCost ?? 20,
          orderReconcileEstimatedCost:
            options.orderReconcileEstimatedCost ?? 10,
          reconciliationDelayMs: options.reconciliationDelayMs ?? 5_000,
          reconciliationMaxAttempts: options.reconciliationMaxAttempts ?? 3,
          processingLeaseMs: options.orderProcessingLeaseMs ?? 5 * 60 * 1000,
          logger,
        });
      },
    }),
    createWorker({
      queueName: QUEUE_NAMES.catalogSync,
      redisUrl: options.redisUrl,
      concurrency: options.catalogConcurrency,
      prefix: options.prefix,
      logger,
      processor: (job) =>
        processCatalogJob(job, {
          prisma: options.prisma,
          pageSize: options.catalogPageSize ?? 100,
          rateGate: options.rateGate,
          estimatedQueryCost: options.catalogQueryEstimatedCost ?? 50,
          logger,
        }),
    }),
    createWorker({
      queueName: QUEUE_NAMES.maintenance,
      redisUrl: options.redisUrl,
      concurrency: 1,
      prefix: options.prefix,
      logger,
      processor: (job) =>
        processMaintenanceJob(job, {
          prisma: options.prisma,
          logger,
        }),
    }),
  ];

  return workers;
}

interface CreateWorkerOptions {
  queueName: QueueName;
  redisUrl: string;
  concurrency: number;
  prefix?: string;
  logger: Logger;
  processor: (job: Job<QueueJobData>) => Promise<unknown>;
}

function createWorker(options: CreateWorkerOptions): Worker<QueueJobData> {
  const worker = new Worker<QueueJobData>(
    options.queueName,
    async (job, token) => {
      try {
        return await options.processor(job);
      } catch (error) {
        if (
          error instanceof OrderWorkDeferredError ||
          error instanceof ShopifyRateLimitDeferredError
        ) {
          await job.moveToDelayed(Date.now() + error.retryAfterMs, token);
          throw new DelayedError();
        }
        throw error;
      }
    },
    {
      connection: createBullMqRedisConnection(options.redisUrl, {
        connectionName: `orderrelay-worker-${options.queueName}`,
      }),
      concurrency: Math.max(1, options.concurrency),
      prefix: options.prefix,
    },
  );

  worker.on("completed", (job) => {
    options.logger.info("queue.job.completed", {
      operationName: job.data.operationName,
      queueName: options.queueName,
      shopId: job.data.shopId,
      outboxEventId: job.data.eventId,
      jobId: job.id,
    });
  });

  worker.on("failed", (job, error) => {
    options.logger.warn("queue.job.failed", {
      operationName: job?.data.operationName,
      queueName: options.queueName,
      shopId: job?.data.shopId,
      outboxEventId: job?.data.eventId,
      jobId: job?.id,
      error: sanitizeErrorMessage(error),
    });
  });

  worker.on("error", (error) => {
    options.logger.error("queue.worker.error", {
      operationName: "queue.worker",
      queueName: options.queueName,
      error: sanitizeErrorMessage(error),
    });
  });

  return worker;
}
