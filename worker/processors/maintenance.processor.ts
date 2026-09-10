import type { PrismaClient } from "@prisma/client";
import {
  JOB_NAMES,
  queueJobDataSchema,
  type QueueJobData,
} from "../../app/queues/jobs.js";
import { QUEUE_NAMES } from "../../app/queues/queue-names.js";
import {
  createSilentLogger,
  type Logger,
} from "../../app/services/logging/logger.server.js";

export interface ProcessableJob<TData> {
  id?: string;
  name: string;
  data: TData;
  attemptsMade?: number;
}

export interface MaintenanceProcessorOptions {
  prisma: PrismaClient;
  logger?: Logger;
}

export interface DiagnosticJobResult {
  status: "handled";
  eventId: string;
  shopId: string;
  jobId: string | null;
}

export async function processMaintenanceJob(
  job: ProcessableJob<QueueJobData>,
  options: MaintenanceProcessorOptions,
): Promise<DiagnosticJobResult> {
  if (job.name !== JOB_NAMES.maintenanceDiagnostic) {
    throw new Error(`Unsupported maintenance job type: ${job.name}`);
  }

  const data = queueJobDataSchema.parse(job.data);
  const event = await options.prisma.outboxEvent.findUnique({
    where: {
      id: data.eventId,
    },
    select: {
      id: true,
      shopId: true,
      eventType: true,
      aggregateType: true,
      aggregateId: true,
    },
  });

  if (!event) {
    throw new Error(`Outbox event not found for job ${job.id ?? "unknown"}`);
  }

  if (
    event.shopId !== data.shopId ||
    event.eventType !== data.eventType ||
    event.aggregateType !== data.aggregateType ||
    event.aggregateId !== data.aggregateId
  ) {
    throw new Error(`Outbox event mismatch for job ${job.id ?? "unknown"}`);
  }

  const logger = options.logger ?? createSilentLogger();
  logger.info("maintenance.diagnostic.handled", {
    operationName: JOB_NAMES.maintenanceDiagnostic,
    queueName: QUEUE_NAMES.maintenance,
    shopId: data.shopId,
    outboxEventId: data.eventId,
    jobId: job.id,
    attemptsMade: job.attemptsMade ?? 0,
  });

  return {
    status: "handled",
    eventId: data.eventId,
    shopId: data.shopId,
    jobId: job.id ?? null,
  };
}
