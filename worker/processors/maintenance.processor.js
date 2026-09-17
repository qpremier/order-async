import { JOB_NAMES, queueJobDataSchema, } from "../../app/queues/jobs.js";
import { QUEUE_NAMES } from "../../app/queues/queue-names.js";
import { createSilentLogger, } from "../../app/services/logging/logger.server.js";
import { processAppLifecycleWebhook } from "../../app/services/webhooks/app-lifecycle.server.js";
export async function processMaintenanceJob(job, options) {
    if (job.name !== JOB_NAMES.maintenanceDiagnostic &&
        job.name !== JOB_NAMES.webhookProcess) {
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
    if (event.shopId !== data.shopId ||
        event.eventType !== data.eventType ||
        event.aggregateType !== data.aggregateType ||
        event.aggregateId !== data.aggregateId) {
        throw new Error(`Outbox event mismatch for job ${job.id ?? "unknown"}`);
    }
    if (job.name === JOB_NAMES.webhookProcess) {
        const payload = data.payload;
        if (typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload) ||
            typeof payload.webhookReceiptId !== "string") {
            throw new Error(`Invalid webhook payload for job ${job.id ?? "unknown"}`);
        }
        return processAppLifecycleWebhook(options.prisma, {
            shopId: data.shopId,
            webhookReceiptId: payload.webhookReceiptId,
        });
    }
    const logger = options.logger ?? createSilentLogger();
    logger.info("maintenance.diagnostic.handled", {
        correlationId: data.correlationId ?? data.eventId,
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
