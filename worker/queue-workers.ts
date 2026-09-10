import { Worker, type Job } from "bullmq";
import type { PrismaClient } from "@prisma/client";
import { createBullMqRedisConnection } from "../app/queues/connection.server.js";
import type { QueueJobData } from "../app/queues/jobs.js";
import { QUEUE_NAMES, type QueueName } from "../app/queues/queue-names.js";
import {
  createSilentLogger,
  sanitizeErrorMessage,
  type Logger,
} from "../app/services/logging/logger.server.js";
import { processMaintenanceJob } from "./processors/maintenance.processor.js";
import { processUnsupportedPhase2Job } from "./processors/unsupported.processor.js";

export interface QueueWorkerOptions {
  redisUrl: string;
  prisma: PrismaClient;
  orderConcurrency: number;
  catalogConcurrency: number;
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
      processor: (job) =>
        processUnsupportedPhase2Job(job, QUEUE_NAMES.orderWrite),
    }),
    createWorker({
      queueName: QUEUE_NAMES.catalogSync,
      redisUrl: options.redisUrl,
      concurrency: options.catalogConcurrency,
      prefix: options.prefix,
      logger,
      processor: (job) =>
        processUnsupportedPhase2Job(job, QUEUE_NAMES.catalogSync),
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
    options.processor,
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
