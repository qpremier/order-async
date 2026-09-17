import { z } from "zod";
import { QUEUE_NAMES } from "./queue-names.js";
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
};
export const JOB_NAMES = {
    orderCreate: "order.create",
    orderReplay: "order.replay",
    orderReconcileAmbiguous: "order.reconcile-ambiguous",
    catalogBootstrap: "catalog.bootstrap",
    catalogRefreshProduct: "catalog.refresh-product",
    catalogReconcile: "catalog.reconcile",
    importValidate: "import.validate",
    webhookProcess: "webhook.process",
    deadLetterReplay: "dead-letter.replay",
    maintenanceDiagnostic: "maintenance.diagnostic",
};
export const queueJobDataSchema = z.object({
    eventId: z.string().min(1),
    correlationId: z.string().min(1).optional(),
    shopId: z.string().min(1),
    aggregateType: z.string().min(1),
    aggregateId: z.string().min(1),
    eventType: z.string().min(1),
    payload: z.unknown(),
    operationName: z.string().min(1),
    enqueuedAt: z.string().datetime(),
});
const EVENT_ROUTING = {
    [OUTBOX_EVENT_TYPES.orderCreate]: {
        queueName: QUEUE_NAMES.orderWrite,
        jobName: JOB_NAMES.orderCreate,
        jobIdPrefix: "order-create",
        dedupeSource: "eventId",
        priority: 1,
    },
    [OUTBOX_EVENT_TYPES.orderReconcileAmbiguous]: {
        queueName: QUEUE_NAMES.orderWrite,
        jobName: JOB_NAMES.orderReconcileAmbiguous,
        jobIdPrefix: "order-reconcile-ambiguous",
        dedupeSource: "eventId",
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
        dedupeSource: "eventId",
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
        queueName: QUEUE_NAMES.orderWrite,
        jobName: JOB_NAMES.orderReplay,
        jobIdPrefix: "dead-letter-replay",
        dedupeSource: "eventId",
        priority: 3,
    },
    [OUTBOX_EVENT_TYPES.phase2Diagnostic]: {
        queueName: QUEUE_NAMES.maintenance,
        jobName: JOB_NAMES.maintenanceDiagnostic,
        jobIdPrefix: "phase2-diagnostic",
        dedupeSource: "aggregateId",
        priority: 50,
    },
};
const nonEmptyId = z.string().min(1);
const SAFE_PAYLOAD_SCHEMAS = {
    [OUTBOX_EVENT_TYPES.orderCreate]: z
        .object({ orderIntentId: nonEmptyId })
        .strip(),
    [OUTBOX_EVENT_TYPES.orderReconcileAmbiguous]: z
        .object({
        orderIntentId: nonEmptyId,
        delayMs: z.number().int().nonnegative().optional(),
    })
        .strip(),
    [OUTBOX_EVENT_TYPES.catalogBootstrap]: z
        .object({ syncRunId: nonEmptyId })
        .strip(),
    [OUTBOX_EVENT_TYPES.catalogRefreshProduct]: z
        .object({
        productGid: nonEmptyId,
        productNumericId: nonEmptyId.optional().nullable(),
        deleted: z.boolean().optional(),
        webhookReceiptId: nonEmptyId.optional(),
    })
        .strip(),
    [OUTBOX_EVENT_TYPES.catalogReconcile]: z.object({}).strip(),
    [OUTBOX_EVENT_TYPES.importValidate]: z.object({}).strip(),
    [OUTBOX_EVENT_TYPES.webhookProcess]: z
        .object({ webhookReceiptId: nonEmptyId })
        .strip(),
    [OUTBOX_EVENT_TYPES.deadLetterReplay]: z
        .object({ orderIntentId: nonEmptyId })
        .strip(),
    [OUTBOX_EVENT_TYPES.phase2Diagnostic]: z
        .object({ diagnosticId: nonEmptyId })
        .strip(),
};
export function describeOutboxJob(event, enqueuedAt = new Date()) {
    const routing = getOutboxEventRouting(event.eventType);
    const payload = buildSafeQueuePayload(event.eventType, event.payload);
    const dedupeValue = routing.dedupeSource === "aggregateId" ? event.aggregateId : event.id;
    const delay = getRequestedDelay(event.eventType, payload);
    return {
        queueName: routing.queueName,
        jobName: routing.jobName,
        jobId: buildDeterministicJobId(routing.jobIdPrefix, dedupeValue),
        data: {
            eventId: event.id,
            correlationId: event.id,
            shopId: event.shopId,
            aggregateType: event.aggregateType,
            aggregateId: event.aggregateId,
            eventType: event.eventType,
            payload,
            operationName: routing.jobName,
            enqueuedAt: enqueuedAt.toISOString(),
        },
        options: {
            jobId: buildDeterministicJobId(routing.jobIdPrefix, dedupeValue),
            priority: routing.priority,
            ...(delay > 0 ? { delay } : {}),
        },
    };
}
export function buildSafeQueuePayload(eventType, payload) {
    const schema = SAFE_PAYLOAD_SCHEMAS[eventType];
    if (!schema) {
        throw new Error(`Unsupported outbox event type: ${eventType}`);
    }
    return schema.parse(payload);
}
export function getOutboxEventRouting(eventType) {
    const routing = EVENT_ROUTING[eventType];
    if (!routing) {
        throw new Error(`Unsupported outbox event type: ${eventType}`);
    }
    return routing;
}
export function buildDeterministicJobId(prefix, value) {
    return `${prefix}__${value.replaceAll(":", "_")}`;
}
function getRequestedDelay(eventType, payload) {
    if (eventType !== OUTBOX_EVENT_TYPES.orderReconcileAmbiguous)
        return 0;
    const delayMs = payload.delayMs;
    return typeof delayMs === "number" && Number.isFinite(delayMs)
        ? Math.max(0, Math.min(Math.floor(delayMs), 24 * 60 * 60 * 1000))
        : 0;
}
