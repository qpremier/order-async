import type { JobsOptions } from "bullmq";
import type { OutboxEvent } from "@prisma/client";
import { z } from "zod";
import { QUEUE_NAMES, type QueueName } from "./queue-names.js";

export const OUTBOX_EVENT_TYPES = {
  orderCreate: "order.create",
  orderReconcileAmbiguous: "order.reconcile-ambiguous",
  catalogBootstrap: "catalog.bootstrap",
  catalogRefreshProduct: "catalog.refresh-product",
  catalogReconcile: "catalog.reconcile",
  importValidate: "import.validate",
  webhookProcess: "webhook.process",
  deadLetterReplay: "dead-letter.replay",
  phase2Diagnostic: "phase2.diagnostic",
} as const;

export const JOB_NAMES = {
  orderCreate: "order.create",
  orderReconcileAmbiguous: "order.reconcile-ambiguous",
  catalogBootstrap: "catalog.bootstrap",
  catalogRefreshProduct: "catalog.refresh-product",
  catalogReconcile: "catalog.reconcile",
  importValidate: "import.validate",
  webhookProcess: "webhook.process",
  deadLetterReplay: "dead-letter.replay",
  maintenanceDiagnostic: "maintenance.diagnostic",
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

export const queueJobDataSchema = z.object({
  eventId: z.string().min(1),
  shopId: z.string().min(1),
  aggregateType: z.string().min(1),
  aggregateId: z.string().min(1),
  eventType: z.string().min(1),
  payload: z.unknown(),
  operationName: z.string().min(1),
  enqueuedAt: z.string().datetime(),
});

export type QueueJobData = z.infer<typeof queueJobDataSchema>;

interface OutboxEventRouting {
  queueName: QueueName;
  jobName: JobName;
  jobIdPrefix: string;
  dedupeSource: "aggregateId" | "eventId";
  priority: number;
}

type OutboxEventLike = Pick<
  OutboxEvent,
  "id" | "shopId" | "aggregateType" | "aggregateId" | "eventType" | "payload"
>;

const EVENT_ROUTING = {
  [OUTBOX_EVENT_TYPES.orderCreate]: {
    queueName: QUEUE_NAMES.orderWrite,
    jobName: JOB_NAMES.orderCreate,
    jobIdPrefix: "order-create",
    dedupeSource: "aggregateId",
    priority: 1,
  },
  [OUTBOX_EVENT_TYPES.orderReconcileAmbiguous]: {
    queueName: QUEUE_NAMES.orderWrite,
    jobName: JOB_NAMES.orderReconcileAmbiguous,
    jobIdPrefix: "order-reconcile-ambiguous",
    dedupeSource: "aggregateId",
    priority: 2,
  },
  [OUTBOX_EVENT_TYPES.catalogBootstrap]: {
    queueName: QUEUE_NAMES.catalogSync,
    jobName: JOB_NAMES.catalogBootstrap,
    jobIdPrefix: "catalog-bootstrap",
    dedupeSource: "aggregateId",
    priority: 10,
  },
  [OUTBOX_EVENT_TYPES.catalogRefreshProduct]: {
    queueName: QUEUE_NAMES.catalogSync,
    jobName: JOB_NAMES.catalogRefreshProduct,
    jobIdPrefix: "catalog-refresh-product",
    dedupeSource: "aggregateId",
    priority: 5,
  },
  [OUTBOX_EVENT_TYPES.catalogReconcile]: {
    queueName: QUEUE_NAMES.catalogSync,
    jobName: JOB_NAMES.catalogReconcile,
    jobIdPrefix: "catalog-reconcile",
    dedupeSource: "eventId",
    priority: 20,
  },
  [OUTBOX_EVENT_TYPES.importValidate]: {
    queueName: QUEUE_NAMES.maintenance,
    jobName: JOB_NAMES.importValidate,
    jobIdPrefix: "import-validate",
    dedupeSource: "aggregateId",
    priority: 5,
  },
  [OUTBOX_EVENT_TYPES.webhookProcess]: {
    queueName: QUEUE_NAMES.maintenance,
    jobName: JOB_NAMES.webhookProcess,
    jobIdPrefix: "webhook-process",
    dedupeSource: "aggregateId",
    priority: 5,
  },
  [OUTBOX_EVENT_TYPES.deadLetterReplay]: {
    queueName: QUEUE_NAMES.maintenance,
    jobName: JOB_NAMES.deadLetterReplay,
    jobIdPrefix: "dead-letter-replay",
    dedupeSource: "aggregateId",
    priority: 3,
  },
  [OUTBOX_EVENT_TYPES.phase2Diagnostic]: {
    queueName: QUEUE_NAMES.maintenance,
    jobName: JOB_NAMES.maintenanceDiagnostic,
    jobIdPrefix: "phase2-diagnostic",
    dedupeSource: "aggregateId",
    priority: 50,
  },
} as const satisfies Record<string, OutboxEventRouting>;

export interface QueueJobDescriptor {
  queueName: QueueName;
  jobName: JobName;
  jobId: string;
  data: QueueJobData;
  options: JobsOptions;
}

export function describeOutboxJob(
  event: OutboxEventLike,
  enqueuedAt: Date = new Date(),
): QueueJobDescriptor {
  const routing = getOutboxEventRouting(event.eventType);
  const dedupeValue =
    routing.dedupeSource === "aggregateId" ? event.aggregateId : event.id;

  return {
    queueName: routing.queueName,
    jobName: routing.jobName,
    jobId: buildDeterministicJobId(routing.jobIdPrefix, dedupeValue),
    data: {
      eventId: event.id,
      shopId: event.shopId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: event.payload,
      operationName: routing.jobName,
      enqueuedAt: enqueuedAt.toISOString(),
    },
    options: {
      jobId: buildDeterministicJobId(routing.jobIdPrefix, dedupeValue),
      priority: routing.priority,
    },
  };
}

export function getOutboxEventRouting(eventType: string): OutboxEventRouting {
  const routing = EVENT_ROUTING[eventType as keyof typeof EVENT_ROUTING];

  if (!routing) {
    throw new Error(`Unsupported outbox event type: ${eventType}`);
  }

  return routing;
}

export function buildDeterministicJobId(prefix: string, value: string): string {
  return `${prefix}__${value.replaceAll(":", "_")}`;
}
